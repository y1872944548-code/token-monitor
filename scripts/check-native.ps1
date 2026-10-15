$ErrorActionPreference = 'Stop'
$pulseRoot = Split-Path -Parent $PSScriptRoot
$pulseCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$pulseTestExe = Join-Path $pulseRoot 'runtime\PulseNativeTests.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $pulseTestExe) -Force | Out-Null
$env:CODEX_PULSE_TEST_NODE = (Get-Command node.exe -ErrorAction Stop).Source
& $pulseCompiler /nologo /codepage:65001 /target:exe /main:PulseNativeTests "/out:$pulseTestExe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $pulseRoot 'native\FloatingPulse.cs') (Join-Path $pulseRoot 'native\PulseNativeTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed' }
& $pulseTestExe (Join-Path $pulseRoot 'runtime\native-layout-tests')
if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
