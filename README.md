# 7-Zip Filetype Theme build system

This repository builds themed binaries for the **official stable 7-Zip release pinned in `config/7zip.lock.json`** (initially 26.04). It supports Windows x86 and x64. Three filetype icon themes and the Windows 11 Ribbon bitmap patch are mapped in one declarative manifest.

The generated `7z.dll` and `7zFM.exe` files are modified upstream binaries. Resource editing invalidates any upstream Authenticode signature; these files are not presented as untouched 7-Zip executables. The official 7-Zip license is included in each generated `.7z` package.

## Build on Windows

Use Node.js 22 LTS or later and npm:

```powershell
npm ci
npm test
npm run build
npm run verify
npm run report
```

`npm run build` downloads and verifies the exact official 7-Zip x86/x64 installers and the official `7zr.exe` extractor listed in the committed lock file. It uses the extractor noninteractively to unpack the upstream installers, edits copied PE resources with `resedit-js`, validates the resulting binaries and creates deterministic `.7z` theme packages with the matching official `7z.exe`. It does not run either installer. Builds never resolve a floating upstream version.

`npm run verify` checks the complete package matrix and resource reports, then runs Windows x86/x64 command-line archive smoke tests: create, list, test, extract, and compare file hashes. `npm test` covers deterministic unit fixtures and visual report generation. `npm run report` writes icon and Ribbon contact sheets plus a resource-diff summary to the ignored `reports/generated/` directory. `OUTPUT_DIR` and `BUILD_DIR` can override local output locations.

The extracted upstream binaries are cached only for the duration of a clean build under ignored `.build/` and `.cache/` paths. The generated `.7z` packages and reports are not committed.

## Theme inventory and resource mappings

`config/themes.json` is the sole build mapping. Filetype groups 0–26 target `7z.dll` at language 1033. Ribbon IDs 100–106, 150–156, and 190 target `7zFM.exe` at language 1033. The compiled Ribbon `.res` files are parsed with strict boundary/type/ID/language checks; only the raw bitmap payload is inserted.

- **Windows 10** artwork by [masamunecyrus](https://www.deviantart.com/masamunecyrus), source attribution retained in `assets/filetypes/windows10/info/readme.txt`.
- **Fluent** artwork by [Th3Z](https://www.deviantart.com/th3z/art/Fluent-7Zip-Icons-874298467).
- **Fluent Blue** artwork by [Th3Z](https://www.deviantart.com/th3z/art/Fluent-Blue-7ZIP-Icons-900248101).
- Historical theme-manager artwork and source files remain under `themes/`, including assets not consumed by this build.
- Windows 10 source icons that are not in the 0–26 release mapping are retained.

The repository does not contain explicit distribution licenses for all contributed artwork. The original attributions and files are preserved, but redistribution rights for third-party theme assets remain unverified. Confirm those rights with the respective authors before distributing the themed packages publicly.

## Reports and manual visual check

The report generator is headless and decodes the ICO formats used in this repository. It creates one contact sheet per filetype theme and one Ribbon bitmap sheet. Resource-diff JSON records old/new hashes, expected-change classification, PE validation and functional test status; `summary.md` gives the compact matrix. CI retains these files as workflow artifacts.

For the initial 26.04 package, manually launch `7zFM.exe` on Windows and inspect the Ribbon layout at normal DPI and high DPI. Also inspect representative filetype icons in Explorer. GUI behavior is not claimed as automated.

## Upstream compatibility PR automation

`.github/workflows/check-upstream.yml` checks the official `ip7z/7zip` latest stable release daily at 08:00 UTC and supports manual dispatch. A newer release updates only `config/7zip.lock.json` on `update/7zip-<version>` and opens or updates one compatibility PR targeting this repository's `master`. It never edits resource mappings or auto-merges. The PR's CI is triggered using a GitHub App token.

One-time repository configuration:

1. Create a GitHub App installed only on `mwyau/7-Zip-Filetype-Theme` with **Contents: read/write** and **Pull requests: read/write** permissions.
2. Add repository variable `APP_ID` and secrets `APP_PRIVATE_KEY`; install the App on this repository and allow Actions to create pull requests.
3. Ensure the default branch is `master`. If the App is missing, scheduled PR automation fails with a diagnostic instead of reporting success.

Compatibility PRs remain review- and merge-gated. Failed compatibility checks stay visible on the open PR with their CI logs and reports.

## CI and approval-gated releases

Pull requests run unit tests, the full Windows x86/x64 build matrix, PE/resource validation, archive integration tests, and visual report generation. PR workflows have read-only repository permissions and cannot publish releases.

Protect `master` in repository rules so pull requests require approval and the successful Compatibility CI build and ClamAV checks. Do not allow bypass of these checks for compatibility changes; workflow files cannot enforce GitHub's merge-protection settings by themselves.

After a merge to `master`, the release workflow rebuilds and validates the entire matrix from that commit, creates SHA-256 checksums and provenance, and uploads the exact successful build as an artifact. Only the final publishing job uses the protected GitHub Environment named `release`; configure required reviewers there so approval is requested immediately before publication. The publishing job checks that `master` has not advanced, validates existing tag/release state, and refuses to overwrite mismatched assets. Release tags use `7zip-<upstream>-theme.<revision>`; increment `themeRevision` in `config/release.json` when theme/build content needs a new package for the same upstream version.

A publication retry will reuse the exact validated artifact. Matching already-published assets are treated as a no-op; a partial release can receive only missing, hash-matching assets. Conflicting tags or assets fail closed and require investigation. No release is published as part of this development work.

## Commands

| Command | Purpose |
|---|---|
| `npm ci` | Install locked Node dependencies |
| `npm run build` | Verify upstream downloads, patch resources, build all `.7z` packages and reports (Windows) |
| `npm test` | Run unit, parser, mapping, version, and visual-report tests |
| `npm run verify` | Validate all outputs and run Windows runtime/package acceptance checks |
| `npm run report` | Generate contact sheets and a human-readable report |
| `npm run check-upstream` | Query the official latest stable release and update the lock metadata if needed |

## Mandatory ClamAV gate

Both compatibility PRs and merged-master release candidates pass a required Ubuntu 26.04 job using Ubuntu's `clamav` and `clamav-freshclam` packages. ClamAV 1.5.0 or later is required for detached CVD signature verification. The workflow stops the `clamav-freshclam` service before invoking the updater itself, then downloads/validates current official signatures and rejects a missing or older-than-48-hours daily database. Main and bytecode database versions, signature counts, and build times are recorded as well.

The scanner verifies the complete expected x86/x64/theme matrix, scans every generated `.dll`/`.exe` directly, lists and extracts each `.7z` package, confirms each archived executable is byte-identical to its raw build output, scans each extracted executable, and scans every archive with ClamAV archive scanning enabled. ClamAV malware detections, scanner errors, missing files, stale signatures, incomplete scan summaries, resource-limit warnings, and archive warnings all fail the job. No external scanning service or token is used.

The `clamav-report-<commit>` workflow artifact contains engine and signature database versions/timestamps, file names and SHA-256 hashes, scan counts, exit code, and verdict. It is uploaded even when scanning fails; potentially infected payloads are not attached to that report. The build artifact is transferred separately only because the scanner and final release need those exact bytes. Before publication, the release job verifies the downloaded raw binaries and archives against the CLEAN scan report and verifies the checksum/provenance manifests. The protected `release` environment is reached only after the ClamAV job succeeds.

A CLEAN verdict means this ClamAV engine and these signature versions did not detect a threat in the scanned files; it is not a guarantee that software is malware-free.
