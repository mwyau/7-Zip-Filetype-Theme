$ErrorActionPreference = 'Stop'
$tag = $env:RELEASE_TAG
$commit = $env:GITHUB_SHA
$repository = $env:GITHUB_REPOSITORY
if (-not $tag -or -not $commit -or -not $repository) { throw 'Missing release environment variables.' }

$master = gh api "repos/$repository/commits/master" --jq .sha
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify current master SHA.' }
if ($master -ne $commit) { throw "Refusing stale publication: master is $master, validated commit is $commit." }

$root = (Resolve-Path '.').Path
$reportPath = Join-Path $root 'clamav-report/report.json'
$scanReport = Get-Content -Raw $reportPath | ConvertFrom-Json
node scripts/verify-clamav-artifact.mjs release-input $reportPath
if ($LASTEXITCODE -ne 0) { throw 'Downloaded release files do not match the successful ClamAV scan report.' }

$dist = Join-Path $root 'release-input/dist'
$archives = @(Get-ChildItem -Path $dist -Filter '*.7z' -File | Sort-Object Name)
if ($archives.Count -ne 8) { throw "Expected all 8 release archives, found $($archives.Count)." }
$provenance = Join-Path $dist 'build-provenance.json'
$checksums = Join-Path $dist 'SHA256SUMS.txt'
if (-not (Test-Path $provenance) -or -not (Test-Path $checksums)) { throw 'Release provenance or checksum manifest is missing.' }
$expected = @{}
foreach ($line in Get-Content $checksums) {
  if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw "Malformed SHA256SUMS line: $line" }
  $expected[$Matches[2]] = $Matches[1]
}
foreach ($file in $archives) {
  $actual = (Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLowerInvariant()
  if ($expected[$file.Name] -ne $actual) { throw "Checksum manifest mismatch for $($file.Name)." }
}
$provenanceHash = (Get-FileHash -Algorithm SHA256 $provenance).Hash.ToLowerInvariant()
if ($expected['build-provenance.json'] -ne $provenanceHash) { throw 'Checksum manifest mismatch for build-provenance.json.' }
if ($expected.Count -ne 9) { throw "Expected checksums for 8 archives and provenance, found $($expected.Count)." }
$prov = Get-Content -Raw $provenance | ConvertFrom-Json
if ($prov.sourceCommit -ne $commit) { throw 'Provenance source commit does not match the validated commit.' }
if ($scanReport.verdict -ne 'CLEAN') { throw 'Refusing to publish without a CLEAN ClamAV verdict.' }

# Keep the release title, notes, and asset labels consistent across new
# releases and partial-asset recovery.
$metadata = Get-Content -Raw 'config/release.json' | ConvertFrom-Json
if ($prov.tag -ne $tag) { throw 'Build record tag does not match the requested release tag.' }
$releaseTitle = "7-Zip $($prov.upstream.version) filetype and Ribbon themes (revision $($metadata.themeRevision))"
$notesTemplate = @'
Theme packages for official **7-Zip {VERSION}** on Windows (x86 and x64).

The theme-building tools are a complete rewrite in Node.js and PowerShell using the original icon and toolbar artwork from [Mr4Mike4/7-Zip-Filetype-Theme](https://github.com/Mr4Mike4/7-Zip-Filetype-Theme) and its credited artists. The build replaces selected resources in binaries extracted from the matching official 7-Zip release.

### Downloads

Choose a package that matches your installed 7-Zip version and architecture:

- **Windows 10**, **Fluent**, or **Fluent Blue**: filetype icons in `7z.dll`. Install one filetype theme.
- **Windows 11 Ribbon**: File Manager toolbar graphics in `7zFM.exe`. This can be combined with a filetype theme of the same version and architecture.
- **SHA256SUMS.txt**: checksums for the eight archives and build record.
- **build-provenance.json**: source commit, pinned upstream binaries and artifact hashes.

These are **replacement binaries, not 7-Zip installers**. Back up your original files before replacing them. The modified binaries invalidate the official Authenticode signatures.

The Windows CI builds and verifies all eight packages, tests resource integrity and archive operations, runs File Manager Options smoke tests, and scans the packages with ClamAV. See the [installation instructions](https://github.com/mwyau/7-Zip-Filetype-Theme#installation) and [artwork attribution and rights](https://github.com/mwyau/7-Zip-Filetype-Theme/blob/master/docs/artwork-rights.md). Redistribution rights for third-party artwork have not been independently verified.
'@
$releaseNotes = $notesTemplate.Replace('{VERSION}', [string]$prov.upstream.version)
$assetLabels = @{
  'windows10-x64.7z' = 'Windows 10 filetype icons - x64'
  'windows10-x86.7z' = 'Windows 10 filetype icons - x86'
  'fluent-x64.7z' = 'Fluent filetype icons - x64'
  'fluent-x86.7z' = 'Fluent filetype icons - x86'
  'fluent-blue-x64.7z' = 'Fluent Blue filetype icons - x64'
  'fluent-blue-x86.7z' = 'Fluent Blue filetype icons - x86'
  'windows11-ribbon-x64.7z' = 'Windows 11 Ribbon toolbar - x64'
  'windows11-ribbon-x86.7z' = 'Windows 11 Ribbon toolbar - x86'
  'SHA256SUMS.txt' = 'SHA-256 checksums for release files'
  'build-provenance.json' = 'Source commit, official inputs, and archive hashes'
}
foreach ($name in @($archives | ForEach-Object Name) + @('SHA256SUMS.txt', 'build-provenance.json')) {
  if (-not $assetLabels.ContainsKey($name)) { throw "No release label defined for $name" }
}

$tagLine = @(git ls-remote origin "refs/tags/$tag")
if ($LASTEXITCODE -ne 0) { throw 'Could not query the existing release tag.' }
$peeledLine = @(git ls-remote origin "refs/tags/$tag^{}")
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the existing release tag.' }
$tagExists = $tagLine.Count -gt 0
$tagCommit = $null
if ($tagExists) {
  $tagObject = ($tagLine[0] -split '\s+')[0]
  $tagCommit = if ($peeledLine.Count -gt 0) { ($peeledLine[0] -split '\s+')[0] } else { $tagObject }
  if ($tagCommit -ne $commit) { throw "Tag $tag points to $tagCommit, not validated commit $commit." }
}

$releaseJson = gh api "repos/$repository/releases/tags/$tag" 2>$null
$releaseExists = $LASTEXITCODE -eq 0
if (-not $releaseExists -and $tagExists -and $tagCommit -ne $commit) { throw 'Existing tag cannot be safely reused.' }
$assets = @($archives | ForEach-Object { "$($_.FullName)#$($assetLabels[$_.Name])" }) + @("$checksums#$($assetLabels['SHA256SUMS.txt'])", "$provenance#$($assetLabels['build-provenance.json'])")
if ($releaseExists -and -not $tagExists) { throw 'Release object exists without its Git tag; refusing publication.' }
if (-not $releaseExists) {
  gh release create $tag @assets --target $commit --title $releaseTitle --notes $releaseNotes
  if ($LASTEXITCODE -ne 0) { throw 'Release creation/upload failed. A partial tag or release may exist; rerun safely after inspecting GitHub Release state.' }
} else {
  $release = $releaseJson | ConvertFrom-Json
  $published = @{}
  foreach ($asset in $release.assets) {
    if ($published.ContainsKey($asset.name)) { throw "Duplicate published release asset $($asset.name)." }
    $published[$asset.name] = ($asset.digest -replace '^sha256:', '').ToLowerInvariant()
  }
  $wanted = @{}
  foreach ($file in $archives) { $wanted[$file.Name] = (Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLowerInvariant() }
  $wanted['SHA256SUMS.txt'] = (Get-FileHash -Algorithm SHA256 $checksums).Hash.ToLowerInvariant()
  $wanted['build-provenance.json'] = $provenanceHash
  foreach ($name in $published.Keys) {
    if (-not $wanted.ContainsKey($name)) { throw "Unexpected existing release asset $name; refusing to overwrite or delete it." }
    if ($published[$name] -ne $wanted[$name]) { throw "Existing release asset $name differs from the validated artifact; refusing overwrite." }
  }
  $missing = @($wanted.Keys | Where-Object { -not $published.ContainsKey($_) })
  if ($missing.Count -gt 0) {
    gh release upload $tag @($missing | ForEach-Object { "$(Join-Path $dist $_)#$($assetLabels[$_])" })
    if ($LASTEXITCODE -ne 0) { throw 'Partial release recovery upload failed. Existing matching assets were retained; rerun after inspection.' }
  } else { Write-Host "Release $tag already contains the exact validated asset set; publication is a no-op." }
}
