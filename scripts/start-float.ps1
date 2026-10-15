param([string]$ThreadId = '', [switch]$EnableCompanion, [switch]$ButtonOnly, [string]$NodePath = '')
$ErrorActionPreference = 'Stop'
$pulseRoot = Split-Path -Parent $PSScriptRoot
$pulseRuntime = Join-Path $pulseRoot 'runtime'
$pulseExe = Join-Path $pulseRuntime 'CodexPulse.exe'
$pulseNode = if ($NodePath) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
$pulseVersion = & $pulseNode -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]($pulseVersion.Split('.')[0]) -lt 24) { throw 'Please install Node.js 24 LTS first.' }
$pulseCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$pulseData = if ($env:CODEX_PULSE_DATA_DIR) { $env:CODEX_PULSE_DATA_DIR } else { $pulseRuntime }
if (!$ThreadId) { $ThreadId = $env:CODEX_THREAD_ID }
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
  if ($pulseExisting -and $pulseExisting.pid -eq $pulseProcess.Id -and ($pulseExisting.threadId -eq $ThreadId -or $pulseExisting.launchThreadId -eq $ThreadId) -and !$pulseNeedsBuild -and !$EnableCompanion -and (!$pulseDismissed -or $ButtonOnly) -and !$pulseCollapse -and !$pulseNeedExpand) { Write-Output 'Codex迷你浮条已在运行'; exit 0 }
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
    $pulseRunKey.SetValue('CodexPulseCompanion',$pulseCommand,[Microsoft.Win32.RegistryValueKind]::String)
  } finally { $pulseRunKey.Dispose() }
}
$pulseArguments = @(('"{0}"' -f $pulseRoot), ('"{0}"' -f $pulseNode), $ThreadId)
if (!$ButtonOnly) { $pulseArguments += '--show' }
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
Write-Output '监控按钮已伴随Codex：移到窗口边缘展开监控按钮，单击打开，×收起后仍可再点打开。'
