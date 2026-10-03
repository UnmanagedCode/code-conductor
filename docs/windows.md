# Windows installer, launcher and update path

A per-user NSIS installer (`.exe`, built on Linux) that gives a standard, non-elevated Windows 11 user a working cc: bundled Node, a real git checkout (so the in-app self-update works unchanged), a Start-menu launcher and an uninstaller. Sources: `installer/windows/`. Tests: `tests/win-installer-*.test.mjs`.

## Build

```bash
sudo apt install nsis            # makensis; also needs git, unzip, tar
npm run build:win-installer      # -> build/win-installer/code-conductor-setup-<version>-<shortsha>.exe
```

| Env var | Default | Meaning |
|---|---|---|
| `CC_WIN_BRANCH` | `main` | Branch the checkout is created on and the bundle carries; must be the branch self-update should follow. |
| `CC_WIN_REMOTE_URL` | `https://github.com/UnmanagedCode/code-conductor.git` | `origin` of the installed checkout. |
| `MAKENSIS` | `makensis` | NSIS compiler. |

- **Inputs:** only `HEAD` is bundled (`git archive` for `installer/windows` + `LICENSE`, `git bundle` for the checkout). A dirty tree and a `HEAD` not contained in `origin/<branch>` each print a warning (the latter makes self-update report ahead/diverged until the commit is on the branch).
- **Reproducible in its inputs** (pinned Node + `HEAD`), not byte-identical.
- **Pins:** `installer/windows/pins.json` is the single source for the Node zip (extracted into the installer at build time) and the Git for Windows installer (downloaded at install time). Each has `version`, `url`, `sha256`; a download whose sha256 differs is refused. To bump: change `version`/`url`, take the sha256 from nodejs.org `SHASUMS256.txt` / the GitHub release asset digest.
- **Cache:** `build/cache/` (gitignored with the rest of `build/`).
- **Compression:** zlib, chosen so the real build fits the suite's per-file deadline.
- **Tests:** `npm test` covers everything with a fake `makensis`; `RUN_WIN_INSTALLER_BUILD=1 node tests/run.mjs tests/win-installer-build.real.test.mjs` runs the real download + real `makensis` and checks for a PE header.

## Install layout

```
%LOCALAPPDATA%\Programs\code-conductor\      fixed (no directory page)
  code-conductor.exe     launcher stub (GUI subsystem, built from launcher.nsi)
  uninstall.exe
  node\                  pinned Node, replaced on every install
  app\                   git checkout of cc (origin = CC_WIN_REMOTE_URL, LF working tree)
  logs\server.log        launcher + server stdout/stderr   (server.prev.log = previous run)
  logs\setup.log         install-time step log
%USERPROFILE%\code-conductor\                projects root; store at .code-conductor\
Start menu (per user)\code-conductor.lnk     -> code-conductor.exe (no run-as-admin flag)
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\code-conductor
```

Nothing is written outside `%USERPROFILE%` and HKCU. `/S` silences both the installer and the uninstaller.

## What the installer does

`installer.nsi` stops a running server (asks first; `/S` answers yes), extracts `node\`, then runs `setup.mjs` with that Node; a nonzero exit aborts the install. `setup.mjs` steps:

1. **Git for Windows.** Detected via `detectGit` (`toolchain.mjs`): `git.exe` on PATH, then `%LOCALAPPDATA%\Programs\Git`, then `%ProgramFiles%\Git`. It counts only when `<root>\bin\bash.exe` exists (Git Bash is the requirement). Otherwise the pinned installer is downloaded (3 attempts), sha256-checked and run `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /CURRENTUSER /NOCANCEL /SP- /o:PathOption=Cmd`.
2. **claude.** `detectClaude`: a `claude.exe` on PATH (an npm `.cmd` shim does not count), then `%USERPROFILE%\.local\bin\claude.exe`. Otherwise `powershell -NoProfile -NonInteractive -Command "irm https://claude.ai/install.ps1 | iex"` (no execution-policy bypass needed). **Signing in is manual:** run `claude auth login` once in a terminal.
3. **User PATH.** `%USERPROFILE%\.local\bin` is appended to `HKCU\Environment\Path` (`addToUserPath`: `reg.exe`, `REG_EXPAND_SZ`, idempotent, case-insensitive, fails closed (only a not-found query means "no Path"; any other failed or unparseable query throws without writing), `%VAR%` entries preserved, no length limit), then the installer broadcasts `WM_SETTINGCHANGE`.
4. **Checkout** (`checkout` in `setup.mjs`):
   - Fresh: `git clone --branch <branch>` from the bundle with `core.autocrlf=false`, then `origin` is set to the real remote URL. The clone gives `branch.<b>.remote/merge`, so self-update has an upstream.
   - Existing: fetch the bundle; fast-forward when `HEAD` is an ancestor of the bundle tip, otherwise keep the checkout (never downgraded or clobbered). If the fast-forward itself is refused (local changes in the way) the checkout is kept, the log says so, and the install continues; in-app self-update handles it. A non-empty directory that is not a checkout is refused.
   - The checkout carries local `core.autocrlf=false` regardless of the user's global Git setting. Dev clones under the Git installer's default `autocrlf=true` are not covered.
5. **`npm ci`** in `app\` with the bundled Node's `npm` (full dependencies, matching what self-update's `npm install` yields).

Re-running a newer installer fast-forwards the checkout; an older one keeps it.

## Launcher

The Start-menu shortcut runs `code-conductor.exe`, an NSIS stub built with `SilentInstall silent` that runs `node\node.exe app\installer\windows\launch.mjs` through `nsExec` (no console window, no script host, no execution policy) and shows `launch.mjs`'s one-line error in a message box on failure. The stub knows only those two relative paths; all logic is in `launch.mjs`, which ships in the checkout, so self-update updates it.

| `launch.mjs` mode | Behaviour |
|---|---|
| (default) | Probe `http://127.0.0.1:<PORT or 8787>/api/health`. cc answering (`app: 'code-conductor'`) → reuse it. Something else answering → fail "port in use by another program"; a 200 health response without `app` → fail "doesn't identify as code-conductor (pre-Windows build?)" (never spawned over). Nothing → rotate `server.log`, write a header (commit, `PROJECTS_ROOT`, PATH head, claude path), `mkdir` the projects root, spawn `node server.ts` detached + hidden with stdout/stderr on `server.log`, poll health every 250 ms (60 s deadline; a child that exits first fails with the log tail; at the deadline the server it spawned is killed by pid whatever the port answers — never any other process; a child that already exited is reported with its exit and log tail first), then open the UI with `rundll32 url.dll,FileProtocolHandler`. |
| `--status` | Exit 0 if cc answers on the port, 1 if nothing (or a stranger) does, 2 with a message if something answers 200 but doesn't identify as cc. The installer and uninstaller abort on 2 (close the server by hand) instead of removing files under a running `node.exe`. |
| `--stop` | `taskkill /T /F /PID <health.pid>`, then wait until health stops answering; nonzero if still up, and nonzero ("cannot stop") for an unidentified server. Used by the installer and uninstaller. |

Server environment (`launcherEnv`): PATH = bundled `node\`, Git's `cmd`, claude's directory, then the inherited PATH (deduplicated case-insensitively); `PROJECTS_ROOT` = the inherited value, else `%USERPROFILE%\code-conductor`. It sets no `CLAUDE_BIN` (that variable is whitespace-split), `HOST`, `PORT` or `CLAUDE_CODE_GIT_BASH_PATH`. Self-update restarts re-spawn with the same environment and log handle.

## Projects root

Fixed at `%USERPROFILE%\code-conductor`; a user-level `PROJECTS_ROOT` environment variable overrides it. There is no installer page for it. The store is always `<root>\.code-conductor`.

## Update

- **In the app:** the self-update UI runs `git pull --ff-only` + `npm install` in `app\` and restarts.
- **By installer:** a newer installer fast-forwards the checkout; see above.

## Uninstall

`uninstall.exe` (Settings → Installed apps, or `/S`) stops a running server, then removes the Start-menu shortcut, `%LOCALAPPDATA%\Programs\code-conductor` (including logs) and the Uninstall key. It keeps `%USERPROFILE%\code-conductor` (projects and store), Git, claude and the PATH entry; delete those by hand if wanted. The uninstaller re-launches itself from a temp copy, so `uninstall.exe /S` returns before the removal finishes: wait for the install directory to disappear.

## Limitations

- Git Bash is required; a bare `git.exe` is not enough. Runtime behaviour on win32 (capabilities, Git Bash resolution, kill semantics): [architecture.md](architecture.md) → `src/platform/win32.ts`.
- Not signed: SmartScreen shows "More info → Run anyway".
- Node's `fetch` ignores the system proxy, so the Git download needs direct access.
- A logon over SSH cannot `taskkill /T` or use WMI; run those steps under an interactive-type logon (e.g. `Start-Process -Credential`).
- The server dies with its logon session when started from a non-interactive logon; a desktop session is unaffected.
- Default NSIS icon.
- A server that fails to start is reported by the launcher with the tail of `logs\server.log`.
