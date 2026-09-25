// Unit tests for the Claude Code stream-json line parser.
// Run with: node --test
//
// Fixtures below are real lines captured from
// `claude -p --output-format stream-json --include-partial-messages --verbose`.

const test = require('node:test');
const assert = require('node:assert');
const { parseStreamJsonLine } = require('../src/utils/claudecode');

test('extracts text from a text_delta stream event', () => {
    const line =
        '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"pong"}},"session_id":"abc"}';
    assert.deepStrictEqual(parseStreamJsonLine(line), { kind: 'text', text: 'pong' });
});

test('ignores thinking_delta events', () => {
    const line =
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"","estimated_tokens":50}}}';
    assert.strictEqual(parseStreamJsonLine(line), null);
});

test('ignores signature_delta events', () => {
    const line = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"xyz"}}}';
    assert.strictEqual(parseStreamJsonLine(line), null);
});

test('ignores content_block_start / message_start events', () => {
    assert.strictEqual(
        parseStreamJsonLine('{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}'),
        null
    );
    assert.strictEqual(parseStreamJsonLine('{"type":"stream_event","event":{"type":"message_start","message":{}}}'), null);
});

test('parses a successful result', () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"result":"Hello there","session_id":"abc"}';
    assert.deepStrictEqual(parseStreamJsonLine(line), {
        kind: 'result',
        text: 'Hello there',
        isError: false,
        error: null,
    });
});

test('flags an error result (is_error true)', () => {
    const line = '{"type":"result","subtype":"error_during_execution","is_error":true,"error":"boom"}';
    const evt = parseStreamJsonLine(line);
    assert.strictEqual(evt.kind, 'result');
    assert.strictEqual(evt.isError, true);
    assert.strictEqual(evt.error, 'boom');
});

test('flags an error result from non-success subtype even without is_error', () => {
    const line = '{"type":"result","subtype":"error_max_turns","result":""}';
    const evt = parseStreamJsonLine(line);
    assert.strictEqual(evt.isError, true);
    assert.strictEqual(evt.error, 'error_max_turns');
});

test('captures session id from system init', () => {
    const line = '{"type":"system","subtype":"init","session_id":"309e7ebd","model":"claude-sonnet-5"}';
    assert.deepStrictEqual(parseStreamJsonLine(line), { kind: 'init', sessionId: '309e7ebd' });
});

test('ignores hook lifecycle system events', () => {
    const line = '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","session_id":"abc"}';
    assert.strictEqual(parseStreamJsonLine(line), null);
});

test('ignores blank lines, whitespace, and invalid JSON', () => {
    assert.strictEqual(parseStreamJsonLine(''), null);
    assert.strictEqual(parseStreamJsonLine('   '), null);
    assert.strictEqual(parseStreamJsonLine('not json'), null);
    assert.strictEqual(parseStreamJsonLine('{"type":'), null);
    assert.strictEqual(parseStreamJsonLine('null'), null);
});
