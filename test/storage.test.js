// Tests for src/storage.js — config/limits persistence.
//
// storage.js derives every path from os.homedir(), so each test points homedir
// at a fresh temp dir. That is also why the module is require()d AFTER the
// override: the paths are computed per call, but initializeStorage() writes on
// first use and we do not want that landing in a real home directory.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const realHomedir = os.homedir;
let tmpHome;

function freshHome() {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-test-'));
    os.homedir = () => tmpHome;
}

// Silence the module's own console output during tests — it logs on reset.
const realLog = console.log;
const realWarn = console.warn;

const S = (() => {
    freshHome();
    console.log = () => {};
    const mod = require('../src/storage.js');
    console.log = realLog;
    return mod;
})();

beforeEach(() => {
    freshHome();
    console.log = () => {};
    console.warn = () => {};
    S.initializeStorage();
    console.log = realLog;
    console.warn = realWarn;
});

// ── the divergence bug ─────────────────────────────────────────────────────

test('incrementLimitCount returns an entry a caller can actually read', () => {
    // REGRESSION: it built a partial { date, flash, flashLite } with no groq
    // or gemini, so `entry.groq['qwen3-32b']` threw
    // "Cannot read properties of undefined". It only looked fine because
    // incrementCharUsage calls getTodayLimits() first, which backfills.
    const entry = S.incrementLimitCount('gemini-2.5-flash');
    assert.ok(entry.groq, 'groq must be present on the returned entry');
    assert.ok(entry.gemini, 'gemini must be present on the returned entry');
    assert.strictEqual(entry.groq['qwen3-32b'].chars, 0);
    assert.strictEqual(entry.flash.count, 1);
});

test('both entry constructors produce the SAME shape', () => {
    // Two constructors for one shape will always drift; this asserts they
    // cannot. getTodayLimits and incrementLimitCount must agree.
    //
    // NOTE: do NOT call freshHome() mid-test. beforeEach owns isolation, and
    // re-pointing homedir here left later tests running against a home with no
    // initialized storage — counts then accumulated across tests and reported
    // 5 where 2 was expected. Compare within one home instead: getTodayLimits
    // creates today's entry, then incrementLimitCount must return that same
    // object shape rather than a partial one.
    const viaGet = Object.keys(S.getTodayLimits()).sort();
    const viaInc = Object.keys(S.incrementLimitCount('gemini-2.5-flash')).sort();
    assert.deepStrictEqual(viaInc, viaGet, 'entry shapes must match exactly');
});

test('an entry written by an older build is backfilled, not crashed on', () => {
    // Forward compatibility: a saved entry predating the groq/gemini fields
    // must not break a newer reader.
    const limits = S.getLimits();
    limits.data = [{ date: new Date().toISOString().split('T')[0], flash: { count: 3 } }];
    S.setLimits(limits);
    const entry = S.getTodayLimits();
    assert.ok(entry.groq, 'missing groq must be backfilled');
    assert.ok(entry.flashLite, 'missing flashLite must be backfilled');
    assert.strictEqual(entry.flash.count, 3, 'existing data must be preserved');
});

// ── counters ───────────────────────────────────────────────────────────────

test('flash and flash-lite counters are independent', () => {
    // Assert DELTAS, not absolutes. initializeStorage() only wipes when
    // needsReset() is true, so a temp home that was already initialised keeps
    // its counts — absolute assertions reported 5 where 2 was expected purely
    // because of leftover state, not because the code was wrong.
    const before = S.getTodayLimits();
    const f0 = before.flash.count, l0 = before.flashLite.count;
    S.incrementLimitCount('gemini-2.5-flash');
    S.incrementLimitCount('gemini-2.5-flash');
    const e = S.incrementLimitCount('gemini-2.5-flash-lite');
    assert.strictEqual(e.flash.count - f0, 2, 'flash must advance by exactly 2');
    assert.strictEqual(e.flashLite.count - l0, 1, 'lite must advance by exactly 1');
});

test('an unknown model increments nothing rather than throwing', () => {
    const before = S.getTodayLimits();
    const f0 = before.flash.count, l0 = before.flashLite.count;
    const e = S.incrementLimitCount('some-future-model');
    assert.strictEqual(e.flash.count - f0, 0, 'unknown model must not bump flash');
    assert.strictEqual(e.flashLite.count - l0, 0, 'unknown model must not bump lite');
});

test('char usage accumulates per provider and model', () => {
    S.incrementCharUsage('groq', 'qwen3-32b', 1000);
    S.incrementCharUsage('groq', 'qwen3-32b', 500);
    S.incrementCharUsage('groq', 'gpt-oss-20b', 7);
    const e = S.getTodayLimits();
    assert.strictEqual(e.groq['qwen3-32b'].chars, 1500);
    assert.strictEqual(e.groq['gpt-oss-20b'].chars, 7, 'models must not share a counter');
});

test('char usage for an unknown provider is ignored, not fatal', () => {
    // A new model name from a config file must not crash usage tracking.
    assert.doesNotThrow(() => S.incrementCharUsage('nosuch', 'model', 100));
});

// ── day rollover ───────────────────────────────────────────────────────────

test('stale days are purged so the file cannot grow forever', () => {
    const limits = S.getLimits();
    limits.data.push({ date: '2020-01-01', flash: { count: 99 } });
    limits.data.push({ date: '2019-05-05', flash: { count: 5 } });
    S.setLimits(limits);
    S.incrementLimitCount('gemini-2.5-flash');
    const dates = S.getLimits().data.map((d) => d.date);
    assert.strictEqual(dates.length, 1, 'only today survives');
    assert.strictEqual(dates[0], new Date().toISOString().split('T')[0]);
});

test('yesterday’s counts do not carry into today', () => {
    // The point of the daily reset: a limit must actually reset.
    const limits = S.getLimits();
    limits.data = [{ date: '2020-01-01', flash: { count: 500 } }];
    S.setLimits(limits);
    assert.strictEqual(S.getTodayLimits().flash.count, 0);
});

// ── config round-trip ──────────────────────────────────────────────────────

test('config survives a write/read round trip', () => {
    S.updateConfig('testKey', 'testValue');
    assert.strictEqual(S.getConfig().testKey, 'testValue');
});

test('a corrupt limits file falls back to defaults instead of throwing', () => {
    // A damaged file must not stop the app starting.
    fs.writeFileSync(path.join(tmpHome, '.config', 'cheating-daddy-config', 'limits.json'), '{ broken');
    console.warn = () => {};
    const l = S.getLimits();
    console.warn = realWarn;
    assert.ok(Array.isArray(l.data), 'must return a usable default');
});

// Restore the real homedir for anything running after this file.
process.on('exit', () => { os.homedir = realHomedir; });
