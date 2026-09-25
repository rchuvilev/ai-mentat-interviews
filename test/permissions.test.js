// Unit tests for macOS media-permission reasoning.
// Run with: node --test
//
// SystemAudioDump captures system audio via ScreenCaptureKit, which requires
// macOS Screen Recording permission. These tests pin down how we translate the
// status from systemPreferences.getMediaAccessStatus('screen') into an
// actionable error (or a green light to proceed).

const test = require('node:test');
const assert = require('node:assert');
const { screenRecordingPermissionError } = require('../src/utils/permissions');

test('returns null when screen recording is granted', () => {
    assert.strictEqual(screenRecordingPermissionError('granted'), null);
});

test('reports a denied permission with the exact status and remediation', () => {
    const msg = screenRecordingPermissionError('denied');
    assert.match(msg, /denied/);
    assert.match(msg, /Screen Recording/);
    assert.match(msg, /System Settings/);
});

test('reports a restricted permission', () => {
    const msg = screenRecordingPermissionError('restricted');
    assert.match(msg, /restricted/);
    assert.match(msg, /Screen Recording/);
});

test('reports not-determined as not yet granted', () => {
    const msg = screenRecordingPermissionError('not-determined');
    assert.match(msg, /not granted/);
    assert.match(msg, /not-determined/);
});

test('handles undefined / unknown status without throwing', () => {
    const msg = screenRecordingPermissionError(undefined);
    assert.match(msg, /unknown/);
});
