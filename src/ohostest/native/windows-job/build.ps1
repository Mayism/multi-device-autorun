param(
  [Parameter(Mandatory=$true)][string]$Zig,
  [ValidateSet('x64','arm64','ia32')][string]$Architecture = 'x64',
  [string]$CacheDirectory = (Join-Path $PSScriptRoot 'build\cache')
)
$ErrorActionPreference = 'Stop'
$targets = @{ x64 = 'x86_64-windows-gnu'; arm64 = 'aarch64-windows-gnu'; ia32 = 'x86-windows-gnu' }
$output = Join-Path $PSScriptRoot "prebuilds\win32-$Architecture\web-job.node"
New-Item -ItemType Directory -Path (Split-Path $output -Parent),$CacheDirectory -Force | Out-Null
$oldCache = $env:ZIG_GLOBAL_CACHE_DIR
try {
  $env:ZIG_GLOBAL_CACHE_DIR = $CacheDirectory
  & $Zig cc -target $targets[$Architecture] -shared -O2 -s -Wall -Wextra -Werror `
    -I (Join-Path $PSScriptRoot 'include') (Join-Path $PSScriptRoot 'job.c') `
    -o $output
  if ($LASTEXITCODE -ne 0) { throw "Native build failed ($LASTEXITCODE)" }
  Get-FileHash -LiteralPath $output -Algorithm SHA256
} finally {
  $env:ZIG_GLOBAL_CACHE_DIR = $oldCache
}
