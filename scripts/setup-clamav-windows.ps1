[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = '1.5.4'
$archiveName = "clamav-$version.win.x64.zip"
$archiveUrl = "https://github.com/Cisco-Talos/clamav/releases/download/clamav-$version/$archiveName"
$archiveSize = [long]225774978
$archiveSha256 = '0d9e0228b2674137ea1a2853566c98a0278ad52ab2582c3d6dbd75373848c395'
$cacheDirectory = Join-Path $repositoryRoot '.cache/clamav'
$buildDirectory = Join-Path $repositoryRoot '.build/clamav'
$archivePath = Join-Path $cacheDirectory $archiveName
$installDirectory = Join-Path $buildDirectory "clamav-$version.win.x64"

New-Item -ItemType Directory -Path $cacheDirectory, $buildDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
  $partialPath = "$archivePath.part"
  if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
  Write-Host "Downloading official ClamAV $version Windows x64 portable ZIP."
  Invoke-WebRequest -Uri $archiveUrl -OutFile $partialPath -ErrorAction Stop
  $download = Get-Item -LiteralPath $partialPath
  $downloadHash = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($download.Length -ne $archiveSize -or $downloadHash -ne $archiveSha256) {
    Remove-Item -LiteralPath $partialPath -Force
    throw "ClamAV portable archive failed pinned size/SHA-256 verification (size $($download.Length), SHA-256 $downloadHash)."
  }
  Move-Item -LiteralPath $partialPath -Destination $archivePath
}

$cachedArchive = Get-Item -LiteralPath $archivePath
$cachedHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cachedArchive.Length -ne $archiveSize -or $cachedHash -ne $archiveSha256) {
  throw "Cached ClamAV portable archive failed pinned size/SHA-256 verification (size $($cachedArchive.Length), SHA-256 $cachedHash)."
}

$scanner = Join-Path $installDirectory 'clamscan.exe'
$freshclam = Join-Path $installDirectory 'freshclam.exe'
if (-not (Test-Path -LiteralPath $scanner -PathType Leaf) -or -not (Test-Path -LiteralPath $freshclam -PathType Leaf)) {
  if (Test-Path -LiteralPath $installDirectory) {
    throw "Incomplete ClamAV extraction already exists at $installDirectory; refusing to use it."
  }
  $stagingDirectory = Join-Path $buildDirectory "extract-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $stagingDirectory)
    $extractedDirectory = Join-Path $stagingDirectory "clamav-$version.win.x64"
    if (-not (Test-Path -LiteralPath (Join-Path $extractedDirectory 'clamscan.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $extractedDirectory 'freshclam.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $extractedDirectory 'sigtool.exe') -PathType Leaf)) {
      throw 'Verified ClamAV archive does not contain the expected x64 scanner tools.'
    }
    Move-Item -LiteralPath $extractedDirectory -Destination $installDirectory
  } finally {
    if (Test-Path -LiteralPath $stagingDirectory) { Remove-Item -LiteralPath $stagingDirectory -Recurse -Force }
  }
}

$versionOutput = (& $scanner --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch "^ClamAV\s+$([regex]::Escape($version))\b") {
  throw "Expected ClamAV $version x64, got '$versionOutput'."
}
Write-Host "Verified official ClamAV $version portable archive and scanner."
Write-Output $installDirectory
