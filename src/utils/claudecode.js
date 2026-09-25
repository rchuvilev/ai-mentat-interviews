const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSystemPrompt } = require('./prompts');

// gemini.js is required lazily to avoid a circular dependency (gemini.js lazily
// requires this module) and to keep this module loadable without Electron
// (so the pure parser below is unit-testable in plain Node).
function sendToRenderer(channel, data) {
    require('./gemini').sendToRenderer(channel, data);
}
function saveConversationTurn(transcription, response) {
    require('./gemini').saveConversationTurn(transcription, response);
}

// ── State ──

let claudeProc = null;
let isActive = false;
let currentSystemPrompt = null;
let claudeModel = 'sonnet';
let claudeBinary = null;

// Per-turn streaming state
let stdoutBuffer = '';
let currentResponse = '';
let isFirstDelta = true;
let pendingTranscription = '';
let sessionId = null;
let intentionalClose = false;

// Tools that must never run — this is a text-only assistant, not an agent.
const DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Glob', 'Grep', 'Task'];

// ── CLI resolution ──
// Electron GUI apps launch with a minimal PATH that usually omits ~/.local/bin,
// Homebrew, etc., so resolve an absolute path to the claude binary explicitly.
function resolveClaudeBinary() {
    if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH)) {
        return process.env.CLAUDE_CLI_PATH;
    }

    const home = os.homedir();
    const candidates = [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        '/usr/bin/claude',
    ];

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (e) {
            // ignore and keep looking
        }
    }

    return 'claude'; // fall back to PATH resolution
}

// ── Stream-json line parsing (pure — exported for testing) ──
// Maps one line of `claude --output-format stream-json` output to a simple event:
//   { kind: 'text', text }                        — incremental assistant text
//   { kind: 'result', text, isError, error }      — end of a turn
//   { kind: 'init', sessionId }                   — session started
//   null                                          — line irrelevant / unparseable
function parseStreamJsonLine(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return null;

    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch (e) {
        return null;
    }
    if (!msg || typeof msg !== 'object') return null;

    if (msg.type === 'stream_event') {
        const event = msg.event;
        // Only text deltas — ignore thinking_delta / signature_delta / etc.
        if (event && event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
            return { kind: 'text', text: event.delta.text || '' };
        }
        return null;
    }

    if (msg.type === 'result') {
        return {
            kind: 'result',
            text: typeof msg.result === 'string' ? msg.result : '',
            isError: msg.is_error === true || (msg.subtype && msg.subtype !== 'success'),
            error: msg.error || (msg.subtype && msg.subtype !== 'success' ? msg.subtype : null),
        };
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
        return { kind: 'init', sessionId: msg.session_id || null };
    }

    return null;
}

// ── Event handling ──

function handleParsedEvent(evt) {
    if (!evt) return;

    if (evt.kind === 'init') {
        if (evt.sessionId) sessionId = evt.sessionId;
        return;
    }

    if (evt.kind === 'text') {
        currentResponse += evt.text;
        sendToRenderer(isFirstDelta ? 'new-response' : 'update-response', currentResponse);
        isFirstDelta = false;
        return;
    }

    if (evt.kind === 'result') {
        const finalText = evt.text || currentResponse;

        if (evt.isError) {
            console.error('[ClaudeCode] Turn ended with error:', evt.error);
            sendToRenderer('update-status', 'Claude error: ' + (evt.error || 'unknown'));
        } else {
            // If no partial deltas streamed (short/instant answer), push it now.
            if (isFirstDelta && finalText) {
                sendToRenderer('new-response', finalText);
            }
            if (finalText && finalText.trim()) {
                saveConversationTurn(pendingTranscription, finalText);
            }
            sendToRenderer('update-status', 'Listening...');
        }

        // Reset per-turn state
        currentResponse = '';
        isFirstDelta = true;
        pendingTranscription = '';
        return;
    }
}

function handleStdout(chunk) {
    stdoutBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleParsedEvent(parseStreamJsonLine(line));
    }
}

// ── Public API ──

// model / transcription are chosen by the caller (gemini.js orchestrator).
async function initializeClaudeCodeSession(profile, customPrompt, model) {
    console.log('[ClaudeCode] Initializing session:', { profile, model });

    currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
    claudeModel = model || 'sonnet';
    claudeBinary = resolveClaudeBinary();

    // Fail fast with a clear message if the CLI is missing or not logged in.
    try {
        const check = spawnSync(claudeBinary, ['--version'], { timeout: 8000 });
        if (check.error || check.status !== 0) {
            const detail = check.error ? check.error.message : 'exit code ' + check.status;
            console.error('[ClaudeCode] claude CLI not usable:', detail);
            sendToRenderer('update-status', 'Claude CLI not found. Install it and run `claude` once to log in.');
            return false;
        }
    } catch (e) {
        console.error('[ClaudeCode] claude CLI check failed:', e);
        sendToRenderer('update-status', 'Claude CLI not found. Install it and run `claude` once to log in.');
        return false;
    }

    // Neutral, stable working directory so the CLI never picks up the user's
    // project files and session state lives in a predictable place.
    let cwd = os.tmpdir();
    try {
        const { app } = require('electron');
        cwd = path.join(app.getPath('userData'), 'claude-code');
        fs.mkdirSync(cwd, { recursive: true });
    } catch (e) {
        // Fall back to tmpdir if electron/app is unavailable.
    }

    const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose', // required by the CLI for stream-json output
        '--include-partial-messages',
        '--setting-sources',
        '', // load no user/project/local settings: no hooks, MCP, skills, CLAUDE.md
        '--strict-mcp-config', // and no MCP servers
        '--effort',
        'low', // minimize thinking latency for a real-time assistant
        '--model',
        claudeModel,
        '--system-prompt',
        currentSystemPrompt,
        // Keep this last: variadic flag consumes all trailing tool names.
        '--disallowedTools',
        ...DISALLOWED_TOOLS,
    ];

    try {
        intentionalClose = false;
        stdoutBuffer = '';
        currentResponse = '';
        isFirstDelta = true;
        pendingTranscription = '';
        sessionId = null;

        claudeProc = spawn(claudeBinary, args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        if (!claudeProc.pid) {
            console.error('[ClaudeCode] Failed to spawn claude process');
            sendToRenderer('update-status', 'Failed to start Claude CLI');
            return false;
        }

        claudeProc.stdout.on('data', handleStdout);

        claudeProc.stderr.on('data', data => {
            const text = data.toString().trim();
            if (text) console.error('[ClaudeCode] stderr:', text);
        });

        // An unhandled 'error' event on a stdio stream (e.g. EPIPE if the CLI
        // exits) crashes the whole process — handle them explicitly.
        claudeProc.stdin.on('error', err => {
            console.error('[ClaudeCode] stdin error:', err && err.message ? err.message : err);
        });
        claudeProc.stdout.on('error', err => {
            console.error('[ClaudeCode] stdout error:', err && err.message ? err.message : err);
        });
        claudeProc.stderr.on('error', err => {
            console.error('[ClaudeCode] stderr error:', err && err.message ? err.message : err);
        });

        claudeProc.on('close', code => {
            console.log('[ClaudeCode] process closed with code:', code);
            claudeProc = null;
            const wasActive = isActive;
            isActive = false;
            if (!intentionalClose && wasActive) {
                sendToRenderer('update-status', 'Claude session ended unexpectedly');
            }
        });

        claudeProc.on('error', err => {
            console.error('[ClaudeCode] process error:', err);
            claudeProc = null;
            isActive = false;
            sendToRenderer('update-status', 'Claude error: ' + err.message);
        });

        isActive = true;
        console.log('[ClaudeCode] Session initialized (pid', claudeProc.pid, ', model', claudeModel, ')');
        return true;
    } catch (error) {
        console.error('[ClaudeCode] Initialization error:', error);
        sendToRenderer('update-status', 'Claude error: ' + error.message);
        isActive = false;
        return false;
    }
}

async function sendToClaudeCode(transcription) {
    if (!isActive || !claudeProc || !claudeProc.stdin || !claudeProc.stdin.writable) {
        console.error('[ClaudeCode] No active session to send to');
        return;
    }

    const text = (transcription || '').trim();
    if (!text) return;

    console.log('[ClaudeCode] Sending:', text.substring(0, 100) + (text.length > 100 ? '...' : ''));

    pendingTranscription = text;
    currentResponse = '';
    isFirstDelta = true;
    sendToRenderer('update-status', 'Generating response...');

    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    try {
        claudeProc.stdin.write(payload + '\n');
    } catch (e) {
        console.error('[ClaudeCode] stdin write failed:', e);
        sendToRenderer('update-status', 'Claude error: ' + e.message);
    }
}

// Manual text input (mirrors localai.sendLocalText).
async function sendClaudeCodeText(text) {
    if (!isActive) {
        return { success: false, error: 'No active Claude session' };
    }
    try {
        await sendToClaudeCode(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function closeClaudeCodeSession() {
    console.log('[ClaudeCode] Closing session');
    intentionalClose = true;
    isActive = false;
    if (claudeProc) {
        try {
            if (claudeProc.stdin && claudeProc.stdin.writable) claudeProc.stdin.end();
        } catch (e) {
            // ignore
        }
        try {
            claudeProc.kill('SIGTERM');
        } catch (e) {
            // ignore
        }
        claudeProc = null;
    }
    stdoutBuffer = '';
    currentResponse = '';
    isFirstDelta = true;
    pendingTranscription = '';
    currentSystemPrompt = null;
    sessionId = null;
}

function isClaudeCodeSessionActive() {
    return isActive;
}

module.exports = {
    initializeClaudeCodeSession,
    sendToClaudeCode,
    sendClaudeCodeText,
    closeClaudeCodeSession,
    isClaudeCodeSessionActive,
    // exported for unit testing
    parseStreamJsonLine,
    resolveClaudeBinary,
};
