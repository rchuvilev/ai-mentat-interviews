# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

<img width="1299" height="424" alt="cd (1)" src="https://github.com/user-attachments/assets/b25fff4d-043d-4f38-9985-f832ae0d0f6e" />

## Repository location

- Local: `/var/minis/repos/ai-mentat-interviews` — **all repos live under `/var/minis/repos/`**
- Remote: `hexstack-apps/ai-mentat-interviews` (private)

## Stack

JavaScript

## Commands

```sh
npm run start        # electron-forge start
npm run package      # electron-forge package
npm run make         # electron-forge make
npm run publish      # electron-forge publish
npm run lint         # echo "No linting configured"
npm run test         # node --test test/*.test.js
```

## Tests

```sh
node test/claudecode.parser.test.js
node test/permissions.test.js
```

## Conventions

- One logical change = one commit, with the measurements behind it.
- Add a `Requested: "..."` trailer citing the originating request.
- Push to the private `hexstack-apps` remote — that is the backup.
- Never `mv` a git repo inside `/var/minis` (it corrupts the object
  store on this Android FS); re-clone from GitHub instead.
- Run tests AND build before deploying; smoke-test the bundle.

## Storage / limits (`src/storage.js`)

Config lives under an OS-specific dir derived from `os.homedir()`
(`~/.config/cheating-daddy-config` on Linux, `Library/Application Support` on
macOS, `AppData/Roaming` on Windows). No Electron import — it is plain node and
therefore directly unit testable.

### 🔴 One shape, one factory

`getTodayLimits()` and `incrementLimitCount()` each built their own day-entry
object and **they diverged**: `incrementLimitCount` produced only
`{ date, flash, flashLite }` with no `groq`/`gemini`, so any caller reading
`entry.groq['qwen3-32b']` on the returned object threw *"Cannot read properties
of undefined"*.

It appeared to work only because `incrementCharUsage()` happens to call
`getTodayLimits()` first, which backfills the missing fields as a side effect —
so the bug was invisible on the common path and fatal on the direct one.

Both now call `makeTodayEntry()`. **Do not build a day entry inline.** Two
constructors for one shape will always drift.

`ensureEntryShape()` backfills fields added after an entry was written, so a
file from an older build does not crash a newer reader. It returns whether it
changed anything, so `getTodayLimits()` only writes when there is something to
write — it previously wrote to disk on every read.

### Testing note — assert deltas, not absolutes

`initializeStorage()` only wipes when `needsReset()` is true, so a temp home
that was already initialised keeps its counts. Absolute assertions on counters
reported `5 !== 2` purely from leftover state while the code was correct.
`test/storage.test.js` asserts *deltas* around each operation.

Verified by mutation: reintroducing the partial-entry bug turns the suite red
(26 → 25 pass), restoring it turns it green.
