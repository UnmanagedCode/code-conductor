# Windows

cc on Windows 11: what differs at runtime, the Start-menu launcher, and the contract the per-user installer relies on. The installer itself is the separate `code-conductor-windows` project.

## Running on Windows

- Git for Windows with Git Bash is required; a bare `git.exe` is not enough.
- Systems, the FUSE union and Voice are off.
- Capabilities, Git Bash resolution and kill semantics: [architecture.md](architecture.md) → `src/platform/win32.ts`.

## Launcher

`bin/windows-launch.mjs` is the Start-menu entry. The installer's stub (`code-conductor.exe`) runs it as `<install>\node\node.exe <install>\app\bin\windows-launch.mjs [--status|--stop]` and shows its one-line error in a message box on failure. It ships in the checkout, so self-update updates it. It is outside `src/` and Windows-only by nature, so it reads no `process.platform`; it imports `resolveGitBash`, `gitRootOfBash` and `taskkillArgv` from `src/platform/win32.ts`. Tests: `tests/windows-launch.test.mjs`.

| Mode | Behaviour |
|---|---|
| (default) | Probe `http://127.0.0.1:<PORT or 8787>/api/health`. cc answering (`app: 'code-conductor'`) → reuse it. Something else answering → fail "port in use by another program"; a 200 health response without `app` → fail "doesn't identify as code-conductor (pre-Windows build?)" (never spawned over). Nothing → resolve Git Bash (`resolveGitBash`; not found → fail "run the installer again"), rotate `server.log`, write a header (commit, `PROJECTS_ROOT`, PATH head, claude path), `mkdir` the projects root, spawn `node server.ts` detached + hidden with stdout/stderr on `server.log`, poll health every 250 ms (60 s deadline; a child that exits first fails with the log tail; at the deadline the server it spawned is killed by pid whatever the port answers — never any other process; a child that already exited is reported with its exit and log tail first), then open the UI with `rundll32 url.dll,FileProtocolHandler`. |
| `--status` | Exit 0 if cc answers on the port, 1 if nothing (or a stranger) does, 2 with a message if something answers 200 but doesn't identify as cc. |
| `--stop` | `taskkill /T /F /PID <health.pid>`, then wait until health stops answering; nonzero if still up, and nonzero ("cannot stop") for an unidentified server. |

**Server environment** (`launcherEnv`): PATH = `<install>\node`, the directory of an existing `git.exe` (the Git Bash install's `cmd`, else its `bin`, else the one on PATH; omitted when there is none), claude's directory, then the inherited PATH (deduplicated case-insensitively). claude is `claude.exe` on PATH (an npm `.cmd` shim does not count), else `%USERPROFILE%\.local\bin\claude.exe`. It sets no `CLAUDE_BIN` (that variable is whitespace-split), `HOST`, `PORT` or `CLAUDE_CODE_GIT_BASH_PATH`. Self-update restarts re-spawn with the same environment and log handle.

**Projects root:** `%USERPROFILE%\code-conductor`; an inherited (user-level) `PROJECTS_ROOT` overrides it. The store is always `<root>\.code-conductor`.

**Logs:** `<install>\logs\server.log` (launcher lines + server stdout/stderr); the previous run's is `server.prev.log`.

## Update

The in-app self-update runs `git pull --ff-only` + `npm install` in `<install>\app` and restarts. It never updates the bundled `<install>\node`; a newer installer release does.

## Installer contract

What the installer (its NSIS scripts, its setup and its build) relies on from a cc ref. Pinned by `tests/windows-installer-contract.test.mjs`. Moving or changing any clause needs a matching installer release.

| # | Clause | Pinned by |
|---|---|---|
| C1 | **Source.** Default source is `https://github.com/UnmanagedCode/code-conductor.git`, branch `main`. The installed checkout's `origin` is that URL, whatever source the build fetched from. | Doc only |
| C2 | **Root files at the ref.** `package.json` has a string `version`; `engines.node` has the form `>=N[.N[.N]]` (the only form the installer's build check parses); `package-lock.json` and `LICENSE` exist. | Contract test |
| C3 | **`npm ci` needs only the bundled Node + npm.** No package in `package-lock.json` has `hasInstallScript`. | Contract test |
| C4 | **Launcher path.** `bin/windows-launch.mjs` relative to the checkout root, run as `<install>\node\node.exe <path> [--status\|--stop]`, independent of cwd. The install dir is the checkout's parent (`defaultInstallDir()`). Installed stubs hard-code the path, so moving it needs an installer release that knows both the old and new paths. | Contract test |
| C5 | **Exit codes.** Default mode: 0 = launched or reused; non-zero = failure, output shown verbatim by the stub (first line is the human message). `--status`: 0 = cc running, 1 = nothing running or a stranger holds the port, 2 = something answers but doesn't identify as cc (the installer aborts on 2). `--stop`: 0 = stopped or not running; non-zero = could not stop. | Contract test (subprocess) |
| C6 | **`/api/health` identity.** A real server answers `app === 'code-conductor'` (all `--status` checks) and an integer `pid` (what `--stop` kills). | Contract test (real `bootServer`) |
| C7 | **Install layout.** `<install>\node\` (node.exe + npm, first on the server PATH so self-update's `npm` is the bundled one), `<install>\app\` = the checkout, `<install>\logs\` (the launcher writes `server.log`/`server.prev.log`; the installer writes `setup.log`). | `tests/windows-launch.test.mjs` |
| C8 | **Tool locations.** With an empty PATH the launcher finds Git Bash at `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` (the installer's per-user `/CURRENTUSER` Git install) and claude at `%USERPROFILE%\.local\bin\claude.exe` (the official installer). Every Git the installer's `detectGit` accepts (`git.exe` in `<root>\cmd` or `<root>\bin`, with `<root>\bin\bash.exe`) `resolveGitBash` also finds. | Contract test |
| C9 | **Checkout recipe → working self-update.** `git -c core.autocrlf=false -c core.eol=lf clone --branch <b> <bundle> app`, then local `core.autocrlf=false`, then `remote set-url origin <url>` gives a clean LF checkout with an upstream that `getSelfUpdateStatus`/`applySelfUpdate` drive unchanged. | Contract test |
| C10 | **Projects root.** Default `%USERPROFILE%\code-conductor`; an inherited `PROJECTS_ROOT` overrides it. The installer's finish/uninstall text names the default. | Contract test (`launcherEnv`) |

## Installer

Built and released by the separate `code-conductor-windows` project. Its README covers the build, install layout, setup steps, uninstall and installer limitations.

## Limitations

- A logon over SSH cannot `taskkill /T` or use WMI; run those steps under an interactive-type logon (e.g. `Start-Process -Credential`).
- The server dies with its logon session when started from a non-interactive logon; a desktop session is unaffected.
- A server that fails to start is reported by the launcher with the tail of `logs\server.log`.
