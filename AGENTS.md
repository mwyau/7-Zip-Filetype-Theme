# Maintainer and coding-agent guide

This is the operational guide for contributors and coding agents working on `mwyau/7-Zip-Filetype-Theme`. Keep `README.md` short and user-facing: supported releases, package choice, installation, previews, warnings, and attribution. Put build internals, maintenance procedures, release operations, and implementation details here instead.

## Project boundaries

- This repository is a maintained fork of `Mr4Mike4/7-Zip-Filetype-Theme`. Do not submit changes to that project or track its releases as a source of new official 7-Zip versions.
- Track stable upstream releases from `ip7z/7zip`, pinned in `config/7zip.lock.json`. The initial supported version is 26.04.
- Currently supported packages are official Windows x86/x64 builds: Windows 10, Fluent and Fluent Blue filetype icons in `7z.dll`, plus the Windows 11 Ribbon toolbar in `7zFM.exe`.
- NSIS and 7-Zip-zstd update flows, ARM64, registry-based icon overrides, and an installer/restore tool are out of scope. Historical artwork under `themes/` is retained.
- Preserve original artwork, credits, source notices, and 7-Zip licensing information. Do not add an unverified blanket license to third-party assets. The source distribution rights for some third-party artwork remain unverified.
- Prefer small and linear changes, exact evidence, and no speculative framework or generalized resource compiler. Do not merge, release, retag, or force-push unless explicitly authorized.

## Build architecture

- Node.js 22 LTS and npm; `package-lock.json` pins dependencies.
- `scripts/core.mjs` validates ICO payloads, builds Windows group-icon records, inspects PE resources and verifies file versions. `scripts/update-resources.ps1` uses one small PowerShell/C# helper around `BeginUpdateResourceW`, `UpdateResourceW`, and `EndUpdateResourceW` to update staged `7z.dll` icon resources and `7zFM.exe` Ribbon bitmaps in one transaction per PE. `pe-library` is a direct pinned dependency; do not reintroduce `resedit`. Neither an installed Windows 7-Zip nor an Ant/Resource Hacker executable is a build prerequisite.
- `config/themes.json` is the sole resource mapping. Do not duplicate architecture-specific mappings in scripts.
- Filetype icon-group IDs **0–26**, language **1033**, target `7z.dll`. Ribbon bitmap IDs **100–106, 150–156, 190**, language **1033**, target `7zFM.exe`.
- Ribbon `.res` inputs are compiled resource containers. Parse and validate their boundaries, declared type/ID/language and payload; never feed the complete `.res` container into a raw bitmap replacement.
- `npm run build` downloads exact installers and `7zr.exe` pinned in the lock file, verifies SHA-256 and size, extracts without executing installers, plans collision-free RT_ICON IDs, patches staged copies through the native writer, verifies icon graph closure and PE invariants, repeats each patch for byte-level reproducibility, and produces deterministic `.7z` packages and build reports.
- Inputs are kept in ignored `.cache/` and `.build/`. Release packages use `dist/`; visual and resource reports are written under `reports/generated/`. Generated binaries, downloads, and reports must not be committed.
- After any asset or mapping change, verify all themes on x86 and x64; check intended resource replacements and make sure unrelated imports, exports and executable contents are unchanged. Modifying PE resources may invalidate Authenticode signatures.

### Local commands

Run on Windows with Node.js 22 and npm:

```powershell
npm ci
npm test
npm run build
npm run verify
npm run report
```

`npm run build` requires external official GitHub release downloads; `npm run verify` checks the complete matrix, resource reports and runtime `.7z`/ZIP smoke tests (create, list, test, extract, compare paths/sizes/hashes, and prove the staged DLL was loaded). `npm run report` makes headless icon and Ribbon contact sheets plus a structured resource diff. `OUTPUT_DIR` and `BUILD_DIR` may override output locations.

Use `npm run check-upstream` for an upstream stable-release check. Review the resulting lock-file changes before committing.

## Source artwork and visual reports

- Canonical filetype inputs: `assets/filetypes/windows10/`, `assets/filetypes/fluent/`, and `assets/filetypes/fluent-blue/`.
- Canonical Ribbon inputs: `assets/toolbar/windows11-ribbon/`.
- The human-facing Fluent preview is `assets/filetypes/fluent/info/preview.png`: it presents the original embedded 256×256, 48×48, 32×32 and 16×16 7z icon entries at their exact native dimensions, followed by all 27 filetype icons at native 48×48. Do not upscale or resample icon entries. This is a documentation preview, not a release input.
- The Windows 11 Ribbon preview is `assets/toolbar/windows11-ribbon/info/preview.png`.
- Generated CI reports contain contact sheets, a human-readable summary and structured resource-diff JSON, including original/patched hashes, expected-change classification, PE verification and functional test status.
- Known follow-up: the generated Windows 11 Ribbon contact sheet currently marks all 15 bitmap tiles `INVALID`; Sharp 0.35.5 reports `Input buffer contains unsupported image format` for the `Bitmap100.res` DIB-to-BMP preview path. This is a preview decoder issue; keep its investigation separate from the native Ribbon executable and the 7z.dll icon migration.
- Manually inspect the patched `7zFM.exe` Ribbon appearance on Windows at normal and high DPI, and check representative filetypes in Explorer. CI does not claim automated GUI confirmation.
- Historical artwork inventories and exact duplicate-hash evidence are in `docs/asset-inventory.md` and `docs/asset-duplicates.csv`. Do not delete unique artwork merely because it is outside the current release matrix.

## Scheduled upstream compatibility PRs

`.github/workflows/check-upstream.yml` checks the official `ip7z/7zip` **latest stable** GitHub release daily at 08:00 UTC, and on `workflow_dispatch`. It compares version and official asset digests with `config/7zip.lock.json`.

For a new release the workflow updates only pinned upstream release metadata on a bot-owned `update/7zip-<version>` branch and opens or updates one PR to `master`. No resource IDs are silently changed. An incompatible update should leave failing CI and reports on the PR, not publish a package. Do not auto-merge compatibility PRs.

One-time fork setup:

1. Enable Actions and scheduled workflows for the fork.
2. Install a repository-scoped GitHub App with **Contents: read/write** and **Pull requests: read/write**.
3. Configure Actions variable `APP_ID` and secret `APP_PRIVATE_KEY`. Use `actions/create-github-app-token` for unattended PR creation/CI; do not use a broad personal access token.
4. Allow required GitHub-maintained actions and the explicitly required third-party `peter-evans/create-pull-request` action if retained in the workflow.
5. Protect `master` with required PR CI checks and restrict force pushes; use the branch rules appropriate for a sole maintainer. Never require a second person's approving review without arranging another reviewer.

The checker must remain idempotent: no duplicate PRs or branches for the same release, no changes for the currently pinned version. The `GITHUB_TOKEN` permissions for PR build jobs remain read-only.

## CI acceptance and malware scan

- `.github/workflows/ci.yml` builds and tests PR changes using Windows x86/x64 7-Zip binaries. The requirements include Node tests, PE/resource integrity, package matrix completeness, runtime archive smoke tests and generated visual reports.
- The PR workflow runs for **all** PRs against `master` without path filters; required CI checks must never be skipped for docs-only PRs.
- `scripts/gui-smoke.ps1` runs on the hosted Windows runner after package verification. On x86/x64 it tests the official baseline and native Ribbon with the official DLL and each themed DLL, opens Tools → Options with the command ID derived from the pinned executable's `RT_MENU` resource, discovers all UI Automation TabItems, selects and verifies each, checks File Manager survival after every selection, and invokes Cancel to close without saving. It also checks startup for every package theme. The optional `-LegacyRibbonRoot <path> -BaselineOnly` mode compares an older Ribbon patch against the official control. The script does not automate Ribbon appearance or DPI validation.
- `.github/workflows/clamav-scan.yml` is a reusable mandatory Windows x64 ClamAV gate for PR checks and release validation. It scans the exact build artifact uploaded by the Windows build job and does not rebuild packages.
- `scripts/setup-clamav-windows.ps1` downloads the official portable ClamAV 1.5.4 Windows x64 ZIP into ignored local build/cache directories and verifies its pinned SHA-256 and size. It makes no system-wide changes.
- The scanner updates signatures with `freshclam.exe` using isolated configuration and database directories, verifies signed `main`, `daily`, and `bytecode` databases, and requires the daily database to be no older than 48 hours. CDN throttling, update failures, missing or stale signatures, and unverified databases fail without scanning.
- The scanner enforces the eight generated PE binaries and eight distribution archives, checks each packaged binary against its raw build output, and scans all 16 inputs with archive scanning enabled. Scanner errors, detections, warnings and incomplete scan counts fail closed.
- `clamav-report-<commit>` records the engine and signature versions, timestamps, scanned artifact SHA-256 hashes, file counts and verdict; the report is uploaded even if setup or scanning fails. A CLEAN result applies only to that scan engine/signature set and is not a malware-free guarantee.
- Never allow a PR job to publish or expose release credentials. Do not run untrusted PR code in privileged `pull_request_target` jobs.

## Release workflow and owner approval

`.github/workflows/release.yml` runs after non-documentation pushes to `master` and on manual dispatch. An early `release-preflight.mjs` job inspects the immutable tag and published asset state: a new tag or incomplete release on the same commit proceeds to full validation, while an already-complete release or a tag pointing to a different commit exits successfully without rebuilding. It never retags an existing release. When eligible, validation rebuilds from the exact merged commit, tests the patched File Manager startup on Windows x86/x64, checks PE/resource integrity, packages, and scans with ClamAV. The publishing job consumes the exact hashed artifacts validated by ClamAV, and rechecks integrity before uploading.

Release tag format: `7zip-<upstream>-theme.<revision>`. `config/release.json` controls the theme revision; increment it when publishing genuinely new theme/build content against the same upstream version.

Set up GitHub Environment `release` with owner `mwyau` as a **required reviewer** and **administrator bypass disabled**. If the repository owner approves their own triggered workflow, do not enable self-review prevention unless another eligible reviewer is available. `scripts/verify-release-environment.mjs` checks the environment policy both before and inside the publishing job.

The publication gate verifies the current `master` SHA, scanned byte hashes, package count, release tag and existing assets. Duplicate matching artifacts are a no-op; different existing tags/assets, partial input matrices and stale commits fail closed. Never retarget an existing release tag.

**Documentation-only changes:** The `release.yml` push trigger ignores `README.md`, `AGENTS.md`, `docs/**`, `assets/**/info/**`, and changes only to `release.yml`. Manual `workflow_dispatch` remains available. This prevents documentation and preview updates from creating redundant release runs, while code and theme-source changes still receive full release validation. Increment `themeRevision` for a genuinely new package; never retag a published version.

After first release, confirm that the generated assets include the full 8-archive matrix, `SHA256SUMS.txt` and `build-provenance.json`. Only claim automated release success after observing it on GitHub Actions.

## Editing policy

- Keep the README human-facing and in English; do not recreate `README RU.md`.
- Keep download URLs, artifact names, checksums and support claims consistent with the actual current GitHub Release.
- Update tests alongside behavior changes and distinguish genuinely executed tests from skipped or unavailable ones.
- Preserve existing attribution and the official 7-Zip license notice in distributed packages.
