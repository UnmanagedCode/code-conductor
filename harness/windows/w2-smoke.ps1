<#
  W2 smoke: runs cc natively on Windows and checks the win32 Platform end to end.
  Run it as a normal (non-elevated) interactive-logon user, from a checkout that
  has had `npm install`:

    powershell -ExecutionPolicy Bypass -File harness\windows\w2-smoke.ps1 `
      -Work C:\Users\ccuser\w2-smoke -Port 8790

  Requires Git for Windows and a signed-in claude on PATH. Everything it creates
  lives under -Work (projects, logs, a bare origin). It prints PASS/FAIL per step
  with the evidence, and leaves no node or claude processes behind.
#>
param(
  [string]$Work = (Join-Path $env:USERPROFILE 'w2-smoke'),
  [int]$Port = 8790,
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)
$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"
$projects = Join-Path $Work 'projects'
$logs = Join-Path $Work 'logs'
$serverLog = Join-Path $logs 'server.log'
New-Item -ItemType Directory -Force $projects, $logs | Out-Null

# ── plumbing ────────────────────────────────────────────────────────────────
$results = [ordered]@{}
function Step([string]$name, [scriptblock]$body) {
  try { $ev = & $body; $results[$name] = @('PASS', "$ev"); Write-Host "PASS  $name  -- $ev" -ForegroundColor Green }
  catch { $results[$name] = @('FAIL', $_.Exception.Message); Write-Host "FAIL  $name  -- $($_.Exception.Message)" -ForegroundColor Red }
}
function Api([string]$method, [string]$path, $body = $null) {
  $a = @{ Method = $method; Uri = "$base$path"; TimeoutSec = 90; ContentType = 'application/json' }
  if ($null -ne $body) { $a.Body = ($body | ConvertTo-Json -Depth 8 -Compress) }
  Invoke-RestMethod @a
}
function WaitFor([scriptblock]$cond, [int]$sec = 60, [string]$what = 'condition') {
  $end = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $end) { if (& $cond) { return } ; Start-Sleep -Milliseconds 300 }
  throw "timed out after ${sec}s waiting for $what"
}
function Pids([string[]]$names) { @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
$watched = 'claude', 'bash', 'sh', 'conhost'
function Leaked([int[]]$before) { @(Pids $watched | Where-Object { $before -notcontains $_ }) }
function Git([string]$dir, [string[]]$a) {
  $out = & git -C $dir -c user.name=w2 -c user.email=w2@example.invalid @a 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($a -join ' ') failed: $out" }
  "$out".Trim()
}
function EventsOf([string]$id) { (Api GET "/api/instances/$id/events?limit=400").events }
function Status([string]$id) { (Api GET '/api/instances' | Where-Object { $_.id -eq $id }).status }
function Spawn($extra = @{}) {
  $b = @{ project = 'demo'; mode = 'bypassPermissions'; temp = $false } + $extra
  $r = Api POST '/api/instances' $b
  WaitFor { (Status $r.id) -eq 'idle' } 90 "instance $($r.id) idle"
  $r
}
function Send([string]$id, [string]$text) { & node (Join-Path $PSScriptRoot 'w2-send.mjs') $Port $id $text | Out-Null; if ($LASTEXITCODE) { throw "send failed ($LASTEXITCODE)" } }
function AssistantText([string]$id) {
  (EventsOf $id | Where-Object { $_.kind -eq 'text_delta' } | ForEach-Object { $_.text }) -join ''
}
function Mcp([string]$tool, $argsObj) {
  $body = @{ jsonrpc = '2.0'; id = 1; method = 'tools/call'; params = @{ name = $tool; arguments = $argsObj } } | ConvertTo-Json -Depth 8 -Compress
  Invoke-RestMethod -Method Post -Uri "$base/mcp" -ContentType 'application/json' -Body $body -TimeoutSec 90
}

# The launcher's environment: bundled node, Git\cmd, claude's dir; no overrides.
$gitCmd = Split-Path (Get-Command git.exe).Source
$claudeDir = Split-Path (Get-Command claude -ErrorAction Stop).Source
$nodeDir = Split-Path (Get-Command node.exe).Source
$launcherPath = "$nodeDir;$gitCmd;$claudeDir;$env:SystemRoot\System32"

$script:serverCmd = $null
function StartServer([string]$root = $projects) {
  $env:PROJECTS_ROOT = $root; $env:PORT = "$Port"; $env:PATH = $launcherPath
  Remove-Item Env:CLAUDE_BIN, Env:CLAUDE_CODE_GIT_BASH_PATH -ErrorAction SilentlyContinue
  $script:serverCmd = Start-Process cmd.exe -WindowStyle Hidden -WorkingDirectory $Repo -PassThru `
    -ArgumentList '/c', "npm start >> `"$serverLog`" 2>&1"
  WaitFor { try { (Api GET '/api/health').ok } catch { $false } } 60 'health'
  Api GET '/api/health'
}
function KillTree([int]$procId) { & "$env:SystemRoot\System32\taskkill.exe" /T /F /PID $procId 2>&1 | Out-Null }
function HealthPid { try { (Api GET '/api/health').pid } catch { $null } }

$baseline = Pids $watched
$health = $null
$h0 = $null
try {
  # 1 ───────────────────────────────────────────────────────────────────────
  Step '1 boot via npm start' {
    $script:h0 = StartServer
    if ($h0.app -ne 'code-conductor') { throw "app=$($h0.app)" }
    if (-not (Get-Process -Id $h0.pid -ErrorAction SilentlyContinue)) { throw "health.pid $($h0.pid) is not a live process" }
    $log = Get-Content $serverLog -Raw
    if ($log -notmatch 'claude OK') { throw 'no "claude OK" in server.log' }
    if ($log -match 'bash\.exe not found') { throw 'Git Bash WARNING in server.log' }
    "app=$($h0.app) pid=$($h0.pid); log has claude OK, no Git Bash warning"
  }
  # 2 ───────────────────────────────────────────────────────────────────────
  Step '2 create project (initial commit)' {
    $null = Api POST '/api/projects' @{ name = 'demo' }
    $n = Git (Join-Path $projects 'demo') @('rev-list', '--count', 'HEAD')
    if ($n -ne '1') { throw "commit count $n" }
    if ((Get-Content $serverLog -Raw) -match 'refusing the initial commit') { throw 'initial commit refused' }
    "rev-list --count HEAD = $n"
  }
  # 3 ───────────────────────────────────────────────────────────────────────
  Step '3 worker answers a prompt' {
    $w = Spawn
    Send $w.id 'Reply with the two letters P and O, then the two letters N and G, joined into one word, and nothing else.'
    WaitFor { (AssistantText $w.id) -match 'PONG' } 120 'PONG'
    $script:w3 = $w
    "assistant text: $((AssistantText $w.id).Trim())"
  }
  # 4 ───────────────────────────────────────────────────────────────────────
  Step '4 claude Bash tool runs under Git Bash' {
    Send $w3.id 'Use the Bash tool to run exactly: echo BV=$BASH_VERSION; pwd'
    WaitFor { (EventsOf $w3.id | Where-Object { $_.kind -eq 'tool_result' } | ConvertTo-Json -Depth 8 -Compress) -match 'BV=\d' } 120 'bash tool_result'
    $res = (EventsOf $w3.id | Where-Object { $_.kind -eq 'tool_result' } | ConvertTo-Json -Depth 8 -Compress)
    if ($res -notmatch '/c/Users') { throw "no /c/Users path in: $res" }
    ($res -replace '\\n', ' ').Substring(0, [Math]::Min(200, $res.Length))
  }
  Api DELETE "/api/instances/$($w3.id)" | Out-Null

  # 5 ───────────────────────────────────────────────────────────────────────
  Step '5 worktree create, commit, sync, merge, hook' {
    $storeDir = Join-Path $projects '.code-conductor\projects\demo'
    New-Item -ItemType Directory -Force $storeDir | Out-Null
    $marker = Join-Path $env:TEMP 'w2-hook-ran.txt'
    Remove-Item $marker -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText((Join-Path $storeDir 'post-worktree-create.sh'), "echo ran > `"`$TEMP/w2-hook-ran.txt`"`n")
    $w = Api POST '/api/instances' @{ project = 'demo'; mode = 'bypassPermissions'; worktree = $true; temp = $false }
    WaitFor { (Status $w.id) -eq 'idle' } 90 'worktree instance idle'
    $wt = $w.worktree
    if (-not (Test-Path $marker)) { throw 'post-worktree hook did not run (env->bash mapping)' }
    [IO.File]::WriteAllText((Join-Path $wt.worktreePath 'w2.txt'), "from worktree`n")
    Git $wt.worktreePath @('add', 'w2.txt') | Out-Null
    Git $wt.worktreePath @('commit', '-q', '-m', 'w2 change') | Out-Null
    Api DELETE "/api/instances/$($w.id)" | Out-Null
    $s = Api POST "/api/projects/demo/worktrees/$($wt.worktreeName)/sync" @{}
    $m = Api POST "/api/projects/demo/worktrees/$($wt.worktreeName)/merge" @{}
    if (-not $m.ok) { throw "merge refused: $($m | ConvertTo-Json -Compress)" }
    $merges = Git (Join-Path $projects 'demo') @('log', '--merges', '--oneline', '-1')
    if (-not $merges) { throw 'no merge commit on parent' }
    if (-not (Test-Path (Join-Path $projects 'demo\w2.txt'))) { throw 'w2.txt not on parent' }
    "hook ran; merge commit: $merges"
  }
  # 6 ───────────────────────────────────────────────────────────────────────
  Step '6 project_bash via /mcp' {
    $r = Mcp 'project_bash' @{ project = 'demo'; command = 'echo hi && git status -s'; description = 'Echo and show status' }
    $txt = $r | ConvertTo-Json -Depth 10 -Compress
    if ($txt -notmatch 'hi') { throw "no output: $txt" }
    if ($r.result.isError) { throw "isError: $txt" }
    $txt.Substring(0, [Math]::Min(220, $txt.Length))
  }
  # 7 ───────────────────────────────────────────────────────────────────────
  Step '7 busy kill: fast, no orphans, jsonl intact' {
    $before = Pids $watched
    $w = Spawn
    Send $w.id 'Use the Bash tool to run `sleep 60`.'
    WaitFor { (EventsOf $w.id | Where-Object { $_.kind -eq 'tool_use' }) } 120 'tool_use'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Api DELETE "/api/instances/$($w.id)" | Out-Null
    $sw.Stop()
    if ($sw.Elapsed.TotalSeconds -gt 7) { throw "DELETE took $([int]$sw.Elapsed.TotalSeconds)s" }
    Start-Sleep -Seconds 1
    $leak = Leaked $before
    if ($leak.Count) { throw "leaked pids: $($leak -join ',') ($((Get-Process -Id $leak -EA SilentlyContinue | % ProcessName) -join ','))" }
    $jsonl = Get-ChildItem (Join-Path $env:USERPROFILE '.claude\projects') -Recurse -Filter "$($w.sessionId).jsonl" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $jsonl) { throw 'no session jsonl' }
    $last = Get-Content $jsonl.FullName -Tail 1
    $null = $last | ConvertFrom-Json   # parses: not truncated mid-line
    "DELETE in $([Math]::Round($sw.Elapsed.TotalSeconds,1))s; no leaked pids; jsonl tail parses"
  }
  # 8 ───────────────────────────────────────────────────────────────────────
  Step '8 idle kill: last-prompt tail, no orphans' {
    $before = Pids $watched
    $w = Spawn
    Send $w.id 'Reply with the single word ok.'
    WaitFor { (Status $w.id) -eq 'idle' -and (AssistantText $w.id) -match 'ok' } 120 'turn done'
    Api DELETE "/api/instances/$($w.id)" | Out-Null
    Start-Sleep -Seconds 1
    $leak = Leaked $before
    if ($leak.Count) { throw "leaked pids: $($leak -join ',')" }
    $jsonl = Get-ChildItem (Join-Path $env:USERPROFILE '.claude\projects') -Recurse -Filter "$($w.sessionId).jsonl" | Select-Object -First 1
    $tail = (Get-Content $jsonl.FullName -Tail 3) -join "`n"
    if ($tail -notmatch 'last-prompt') { throw "no last-prompt in tail: $tail" }
    'jsonl tail has last-prompt; no leaked pids'
  }
  # 9 ───────────────────────────────────────────────────────────────────────
  Step '9 resume restart' {
    $w = Spawn
    Send $w.id 'Reply with the single word ready.'
    WaitFor { (AssistantText $w.id) -match 'ready' } 120 'ready'
    $script:sid9 = $w.sessionId
    $oldPid = HealthPid
    $before = Pids $watched
    $null = Api POST '/api/admin/restart' @{ resume = $true }
    WaitFor { $p = HealthPid; $p -and $p -ne $oldPid } 120 'replacement server'
    Start-Sleep -Seconds 3
    $rows = Api GET '/api/projects/demo/sessions'
    if (-not ($rows | Where-Object { $_.sessionId -eq $sid9 })) { throw "session $sid9 not listed after restart" }
    $inst = Api GET '/api/instances' | Where-Object { $_.sessionId -eq $sid9 }
    if (-not $inst) { throw 'session not resurrected' }
    $ev = EventsOf $inst.id
    if (-not ($ev | Where-Object { $_.kind -eq 'text_delta' -and $_.text -match 'ready' })) { throw 'history did not page from the jsonl' }
    $script:w9 = $inst
    "pid $oldPid -> $(HealthPid); session listed, resurrected, history paged ($($ev.Count) events)"
  }
  # 10 ──────────────────────────────────────────────────────────────────────
  Step '10 plain restart leaves no bash/conhost orphans' {
    $oldPid = HealthPid
    $null = Api POST '/api/admin/restart' @{}
    WaitFor { $p = HealthPid; $p -and $p -ne $oldPid } 120 'replacement server'
    Start-Sleep -Seconds 3
    # Only the old server's own children could be orphans: nothing may be parented to a dead pid.
    $orphans = @(Get-CimInstance Win32_Process -Filter "Name='bash.exe' OR Name='sh.exe'" | Where-Object {
        $_.ParentProcessId -ne 0 -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) })
    if ($orphans.Count) { throw "orphan shells: $(($orphans | % ProcessId) -join ',')" }
    "pid $oldPid -> $(HealthPid); no orphaned bash/sh"
  }
  # 12 ──────────────────────────────────────────────────────────────────────
  Step '12 case drift: lower-case PROJECTS_ROOT still lists the session' {
    KillTree (HealthPid)
    WaitFor { -not (HealthPid) } 30 'server down'
    $h = StartServer $projects.ToLower()
    $rows = Api GET '/api/projects/demo/sessions'
    if (-not ($rows | Where-Object { $_.sessionId -eq $sid9 })) { throw 'session not listed under lower-case root' }
    "root spelled $($projects.ToLower()); session $sid9 listed"
  }
  # 11 ──────────────────────────────────────────────────────────────────────
  Step '11 self-update via bare origin (npm under Git Bash, restart)' {
    KillTree (HealthPid); WaitFor { -not (HealthPid) } 30 'server down'
    $null = StartServer
    $origin = Join-Path $Work 'origin.git'
    $seed = Join-Path $Work 'seed'
    Remove-Item $origin, $seed -Recurse -Force -ErrorAction SilentlyContinue
    $null = & git init -q --bare $origin
    $oldRemote = Git $Repo @('remote', 'get-url', 'origin')
    $branch = Git $Repo @('rev-parse', '--abbrev-ref', 'HEAD')
    Git $Repo @('push', '-q', $origin, "HEAD:refs/heads/$branch") | Out-Null
    Git $Repo @('remote', 'set-url', 'origin', $origin) | Out-Null
    Git $Repo @('fetch', '-q', 'origin') | Out-Null
    Git $Repo @('branch', '--set-upstream-to', "origin/$branch") | Out-Null
    $null = & git clone -q $origin $seed
    # A package.json edit (depsChanged) is what makes the update run npm install.
    $pj = Join-Path $seed 'package.json'
    $pkg = Get-Content $pj -Raw | ConvertFrom-Json
    $pkg | Add-Member -NotePropertyName w2Marker -NotePropertyValue $true -Force
    [IO.File]::WriteAllText($pj, (($pkg | ConvertTo-Json -Depth 20) + "`n"))
    Git $seed @('commit', '-q', '-am', 'w2 update') | Out-Null
    Git $seed @('push', '-q', 'origin', "HEAD:$branch") | Out-Null
    $newHead = Git $seed @('rev-parse', 'HEAD')
    $st = Api GET '/api/settings/self-update'
    if (-not $st.updateAvailable) { throw "no update available: $($st | ConvertTo-Json -Compress)" }
    $oldBoot = (Api GET '/api/health').bootId; $oldPid = HealthPid
    $raw = Invoke-WebRequest -Method Post -Uri "$base/api/settings/self-update" -UseBasicParsing -TimeoutSec 300
    $res = ($raw.Content -split "`n" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.type -eq 'result' })
    if (-not $res.ok) { throw "update failed: $($raw.Content.Substring([Math]::Max(0,$raw.Content.Length-400)))" }
    if (-not $res.result.npm.ran -or -not $res.result.npm.ok) { throw "npm install did not run ok: $($res.result.npm | ConvertTo-Json -Compress)" }
    if ((Git $Repo @('rev-parse', 'HEAD')) -ne $newHead) { throw 'HEAD is not the new commit' }
    $mark = (Get-Item $serverLog).Length
    $null = Api POST '/api/admin/restart' @{}
    WaitFor { $p = HealthPid; $p -and $p -ne $oldPid } 120 'replacement server'
    $h = Api GET '/api/health'
    if ($h.bootId -eq $oldBoot) { throw 'bootId unchanged' }
    Start-Sleep -Seconds 2
    if ((Get-Item $serverLog).Length -le $mark) { throw 'replacement wrote nothing to server.log (stdio inherit)' }
    $script:origRemote = $oldRemote
    "HEAD=$($newHead.Substring(0,8)); npm ok; pid $oldPid -> $($h.pid), new bootId; log continued"
  }
  # 11b ─────────────────────────────────────────────────────────────────────
  Step '11b health-pid stop leaves nothing behind' {
    $w = Spawn
    $before = Pids $watched | Where-Object { $true }
    $p = HealthPid
    $kids = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p } | % ProcessId)
    KillTree $p
    WaitFor { -not (HealthPid) } 30 'server down'
    Start-Sleep -Seconds 1
    $alive = @(Pids @('node', 'claude', 'bash', 'sh') | Where-Object { $_ -eq $p -or $kids -contains $_ })
    if ($alive.Count) { throw "survivors: $($alive -join ',')" }
    $claudeLeft = @(Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $baseline -notcontains $_.Id })
    if ($claudeLeft.Count) { throw "claude survivors: $(($claudeLeft | % Id) -join ',')" }
    "taskkill /T /F /PID $p: server and $($kids.Count) children gone"
  }
  # 13 ──────────────────────────────────────────────────────────────────────
  Step '13 no new visible windows (best effort)' {
    $win = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -in 'node', 'bash', 'sh', 'claude', 'conhost', 'cmd' })
    if ($win.Count) { throw "windows: $(($win | % { "$($_.ProcessName)#$($_.Id)" }) -join ',')" }
    'no node/bash/claude/cmd window handles'
  }
}
finally {
  $p = HealthPid
  if ($p) { KillTree $p }
  if ($script:serverCmd) { KillTree $script:serverCmd.Id }
  Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $baseline -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($script:origRemote) { & git -C $Repo remote set-url origin $script:origRemote 2>&1 | Out-Null }
}

Write-Host "`n==== W2 smoke ====" -ForegroundColor Cyan
$results.GetEnumerator() | ForEach-Object { '{0,-4} {1}  {2}' -f $_.Value[0], $_.Key, $_.Value[1] }
$failed = @($results.Values | Where-Object { $_[0] -eq 'FAIL' }).Count
Write-Host ("{0} passed, {1} failed" -f ($results.Count - $failed), $failed)
exit ([int]($failed -gt 0))
