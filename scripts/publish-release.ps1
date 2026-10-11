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
$assets = @($archives | ForEach-Object { $_.FullName }) + @($checksums, $provenance)
if ($releaseExists -and -not $tagExists) { throw 'Release object exists without its Git tag; refusing publication.' }
if (-not $releaseExists) {
  gh release create $tag @assets --target $commit --title "7-Zip $($prov.upstream.version) theme package $tag" --notes "This release contains modified 7-Zip binaries with third-party theme resources. They are not official untouched 7-Zip executables. The upstream Authenticode signature is invalidated. See build-provenance.json and SHA256SUMS.txt."
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
    gh release upload $tag @($missing | ForEach-Object { Join-Path $dist $_ })
    if ($LASTEXITCODE -ne 0) { throw 'Partial release recovery upload failed. Existing matching assets were retained; rerun after inspection.' }
  } else { Write-Host "Release $tag already contains the exact validated asset set; publication is a no-op." }
}
