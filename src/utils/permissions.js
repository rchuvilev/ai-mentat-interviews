// Pure helpers for reasoning about macOS media permissions.
// Kept dependency-free (no electron require) so it can be unit-tested under
// plain `node --test` without an Electron runtime.

// SystemAudioDump taps system audio via ScreenCaptureKit, which requires macOS
// Screen Recording permission. Given the status returned by
// systemPreferences.getMediaAccessStatus('screen'), return a human-readable,
// actionable error when capture cannot proceed, or null when it can.
//
// Possible statuses: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
function screenRecordingPermissionError(status) {
    if (status === 'granted') return null;

    const fix =
        'Enable Screen Recording for this app in System Settings ▸ Privacy & Security ▸ Screen Recording, then fully quit and reopen the app.';

    if (status === 'denied' || status === 'restricted') {
        return `Screen Recording permission was ${status}. System audio capture can't start. ${fix}`;
    }

    // 'not-determined', 'unknown', or any unexpected/empty value.
    return `Screen Recording permission is not granted (status: ${status || 'unknown'}). System audio capture can't start. ${fix}`;
}

module.exports = { screenRecordingPermissionError };
