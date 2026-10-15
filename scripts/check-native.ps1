$ErrorActionPreference = 'Stop'
$pulseRoot = Split-Path -Parent $PSScriptRoot
$pulseCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$pulseTestExe = Join-Path $pulseRoot 'runtime\PulseNativeTests.exe'
$pulseTestOutput = Join-Path $pulseRoot 'runtime\native-layout-tests'
New-Item -ItemType Directory -Path (Split-Path -Parent $pulseTestExe) -Force | Out-Null
$env:CODEX_PULSE_TEST_NODE = (Get-Command node.exe -ErrorAction Stop).Source
$pulseFailureFile = Join-Path $pulseTestOutput 'native-test-error.txt'
if (Test-Path -LiteralPath $pulseFailureFile) { Remove-Item -LiteralPath $pulseFailureFile }
& $pulseCompiler /nologo /codepage:65001 /target:exe /main:PulseNativeTests "/out:$pulseTestExe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll (Join-Path $pulseRoot 'native\FloatingPulse.cs') (Join-Path $pulseRoot 'native\PulseNativeTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native test compilation failed' }
& $pulseTestExe $pulseTestOutput
if ($LASTEXITCODE -ne 0) {
  if (Test-Path -LiteralPath $pulseFailureFile) {
    $pulseFailure = Get-Content -LiteralPath $pulseFailureFile -Raw -Encoding UTF8
    if ($env:GITHUB_ACTIONS -eq 'true') {
      $pulseAnnotation = $pulseFailure.Replace('%','%25').Replace("`r",'%0D').Replace("`n",'%0A')
      Write-Output ('::error title=Native test failure::' + $pulseAnnotation)
    }
    Write-Output $pulseFailure
  }
  throw 'Native tests failed'
}
