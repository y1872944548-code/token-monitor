param([switch]$Start, [switch]$EnableCompanion)
$ErrorActionPreference = 'Stop'
$pulseRoot = Split-Path -Parent $PSScriptRoot
Push-Location $pulseRoot
try {
  $pulseNode = (Get-Command node.exe -ErrorAction Stop).Source
  $pulseVersion = & $pulseNode -p 'process.versions.node'
  if ($LASTEXITCODE -ne 0 -or [int]($pulseVersion.Split('.')[0]) -lt 24) { throw 'Please install Node.js 24 LTS first.' }
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & $pulseNode (Join-Path $PSScriptRoot 'configure-mcp.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'MCP configuration failed.' }
  $pulseTests = @(Get-ChildItem (Join-Path $pulseRoot 'test\*.test.mjs') | ForEach-Object { $_.FullName })
  & $pulseNode --test @pulseTests
  if ($LASTEXITCODE -ne 0) { throw 'Node tests failed.' }
  & (Join-Path $PSScriptRoot 'check-native.ps1')
  if ($Start -or $EnableCompanion) {
    & (Join-Path $PSScriptRoot 'start-float.ps1') -EnableCompanion:$EnableCompanion -ButtonOnly
  }
  Write-Output 'Setup and tests completed. Run npm run start:windows to open the monitor.'
} finally { Pop-Location }
