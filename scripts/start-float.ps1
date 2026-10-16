param([string]$ThreadId = '', [switch]$EnableCompanion, [switch]$ButtonOnly, [string]$NodePath = '', [ValidateSet('codex','claude-code','antigravity')][string]$Client = 'codex', [uint32]$HostPid = 0, [string]$DataDirectory = '', [switch]$FollowThread)
$ErrorActionPreference = 'Stop'
$pulseRoot = Split-Path -Parent $PSScriptRoot
$pulseBase = if ($env:CODEX_PULSE_DATA_DIR) { $env:CODEX_PULSE_DATA_DIR } else { Join-Path $pulseRoot 'runtime' }
$pulseRuntime = if ($Client -eq 'codex') { Join-Path $pulseRoot 'runtime' } else { Join-Path $pulseRoot ('runtime\clients\' + $Client) }
$pulseExe = Join-Path $pulseRuntime 'CodexPulse.exe'
$pulseNode = if ($NodePath) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
$pulseVersion = & $pulseNode -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($pulseVersion.Split('.')[0]) -lt 24) { throw 'Please install Node.js 24 LTS first.' }
$pulseCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$pulseData = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } elseif ($Client -eq 'codex') { $pulseBase } else { Join-Path $pulseBase ('clients\' + $Client) }
$pulsePreviousClient = $env:CODEX_PULSE_CLIENT
$pulsePreviousData = $env:CODEX_PULSE_CLIENT_DATA_DIR
$pulsePreviousHost = $env:CODEX_PULSE_HOST_PID
try {
$env:CODEX_PULSE_CLIENT = $Client
$env:CODEX_PULSE_CLIENT_DATA_DIR = $pulseData
$env:CODEX_PULSE_HOST_PID = if ($HostPid) { [string]$HostPid } else { '' }
if (!$ThreadId -and $Client -eq 'codex') { $ThreadId = $env:CODEX_THREAD_ID }
if (!$ThreadId) {
  $pulseBootstrap = & $pulseNode (Join-Path $pulseRoot 'src\portable-bootstrap.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Monitor initialization failed; saved settings were preserved.' }
  $ThreadId = ($pulseBootstrap | ConvertFrom-Json).threadId
}
if ($ThreadId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') { throw '需要有效聊天ID' }
$pulseSource = Join-Path $pulseRoot 'native\FloatingPulse.cs'
$pulseNeedsBuild = !(Test-Path -LiteralPath $pulseExe)
if (!$pulseNeedsBuild) { $pulseNeedsBuild = (Get-Item -LiteralPath $pulseSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $pulseExe).LastWriteTimeUtc }
if (!(Test-Path -LiteralPath $pulseNode)) { throw '本机Node路径不可用' }
foreach ($pulseProcess in @(Get-Process -Name 'CodexPulse' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $pulseExe })) {
  $pulseExisting = $null
  for ($pulseAttempt=0; $pulseAttempt -lt 20; $pulseAttempt++) {
    try { $pulseExisting = Get-Content -LiteralPath (Join-Path $pulseData 'float-status.json') -Raw | ConvertFrom-Json } catch {}
    if ($pulseExisting -and $pulseExisting.pid -eq $pulseProcess.Id) { break }
    Start-Sleep -Milliseconds 50
  }
  $pulseCollapse = $ButtonOnly -and $pulseExisting -and $pulseExisting.panelExpanded
  $pulseNeedExpand = !$ButtonOnly -and $pulseExisting -and ($pulseExisting.PSObject.Properties.Name -contains 'panelExpanded') -and !$pulseExisting.panelExpanded
  $pulseDismissed = $pulseExisting -and $pulseExisting.hostReady -and !$pulseExisting.visible -and !$pulseExisting.ownerMinimized
  $pulseSameLauncher = !$env:CODEX_PULSE_CLAUDE_LAUNCH_PID -or ([string]$pulseExisting.streamLauncherPid -eq $env:CODEX_PULSE_CLAUDE_LAUNCH_PID)
  if ($pulseExisting -and $pulseExisting.pid -eq $pulseProcess.Id -and $pulseSameLauncher -and $pulseExisting.pinnedHostPid -eq $HostPid -and (!$FollowThread -or ($pulseExisting.scope.mode -eq 'thread' -and $pulseExisting.threadId -eq $ThreadId)) -and ($pulseExisting.threadId -eq $ThreadId -or $pulseExisting.launchThreadId -eq $ThreadId) -and !$pulseNeedsBuild -and !$EnableCompanion -and (!$pulseDismissed -or $ButtonOnly) -and !$pulseCollapse -and !$pulseNeedExpand) { Write-Output 'Client monitor is already running'; exit 0 }
  Stop-Process -Id $pulseProcess.Id
  $pulseProcess.WaitForExit(1500) | Out-Null
}
New-Item -ItemType Directory -Path $pulseRuntime -Force | Out-Null
if ($pulseNeedsBuild) {
  & $pulseCompiler /nologo /codepage:65001 /target:winexe "/out:$pulseExe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $pulseSource
  if ($LASTEXITCODE -ne 0) { throw '浮条编译失败' }
}
if ($EnableCompanion) {
  $pulseRunKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
  try {
    $pulseCommand = ('"{0}" "{1}" "{2}" {3}' -f $pulseExe,$pulseRoot,$pulseNode,$ThreadId)
    $pulseRunName = 'CodexPulseCompanion'
    if ($Client -ne 'codex') {
      $pulseRunName += '-' + $Client
      $pulseCommand = ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Client {1} -NodePath "{2}" -DataDirectory "{3}" -ButtonOnly' -f (Join-Path $PSScriptRoot 'start-float.ps1'),$Client,$pulseNode,$pulseData)
    }
    $pulseRunKey.SetValue($pulseRunName,$pulseCommand,[Microsoft.Win32.RegistryValueKind]::String)
  } finally { $pulseRunKey.Dispose() }
}
$pulseArguments = @(('"{0}"' -f $pulseRoot), ('"{0}"' -f $pulseNode), $ThreadId)
if (!$ButtonOnly) { $pulseArguments += '--show' }
if ($FollowThread) { $pulseArguments += '--follow-thread' }
$pulseStarted = Start-Process -FilePath $pulseExe -ArgumentList $pulseArguments -WorkingDirectory $pulseRoot -PassThru
$pulseReady = $false
for ($pulseReadyAttempt=0; $pulseReadyAttempt -lt 100; $pulseReadyAttempt++) {
  try {
    $pulseReadyState = Get-Content -LiteralPath (Join-Path $pulseData 'float-status.json') -Raw | ConvertFrom-Json
    if ($pulseReadyState.pid -eq $pulseStarted.Id) { $pulseReady = $true; break }
  } catch {}
  if ($pulseStarted.HasExited) { throw '监控组件启动后已退出' }
  Start-Sleep -Milliseconds 50
}
if (!$pulseReady) { throw '监控组件未在5秒内上报启动状态，请检查本机运行日志' }
Write-Output ('Monitor ready for ' + $Client + '. The edge button appears when a matching client window is found.')
} finally {
  $env:CODEX_PULSE_CLIENT = $pulsePreviousClient
  $env:CODEX_PULSE_CLIENT_DATA_DIR = $pulsePreviousData
  $env:CODEX_PULSE_HOST_PID = $pulsePreviousHost
}
