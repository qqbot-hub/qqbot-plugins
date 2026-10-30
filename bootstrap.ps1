$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Node LTS >=22.13 from https://nodejs.org then rerun bootstrap.ps1' }
  winget install --id OpenJS.NodeJS.LTS --exact --source winget
  if ($LASTEXITCODE -ne 0) { throw 'Node installation incomplete. Finish installer/UAC then rerun.' }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Primary deployment requires Node >=22.13. Upgrade Node LTS.' }
npm.cmd ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed. Check network/proxy/certificates.' }
& (Join-Path $PSScriptRoot 'start.bat')
