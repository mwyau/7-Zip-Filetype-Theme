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
- `scripts/core.mjs` validates ICO payloads, builds Windows group-icon records, inspects PE resources and verifies file versions. `scripts/update-resources.ps1` uses one small PowerShell/C# helper around `BeginUpdateResourceW`, `UpdateResourceW`, and `EndUpdateResourceW` to update staged `7z.dll` icon resources and `7zFM.exe` Ribbon bitmaps in one transaction per PE. `pe-library` is a direct pinned dependency. Neither an installed Windows 7-Zip nor an Ant/Resource Hacker executable is a build prerequisite.
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

`npm run build` requires external official GitHub release downloads; `npm run verify` checks the complete matrix, resource reports, all 27 native icon groups for each filetype theme and architecture at the shared 16/32/48/256-pixel sizes, and runtime `.7z`/ZIP smoke tests (create, list, test, extract, compare paths/sizes/hashes, and prove the staged DLL was loaded). `npm run report` makes headless icon and Ribbon contact sheets plus a structured resource diff. `OUTPUT_DIR` and `BUILD_DIR` may override output locations.

Use `npm run check-upstream` for an upstream stable-release check. Review the resulting lock-file changes before committing.

## Source artwork and visual reports

- Canonical filetype inputs: `assets/filetypes/windows10/`, `assets/filetypes/fluent/`, and `assets/filetypes/fluent-blue/`.
- Canonical Ribbon inputs: `assets/toolbar/windows11-ribbon/`.
- The human-facing Fluent preview is `assets/filetypes/fluent/info/preview.png`: it presents the original embedded 256×256, 48×48, 32×32 and 16×16 7z icon entries at their exact native dimensions, followed by all 27 filetype icons at native 48×48. Do not upscale or resample icon entries. This is a documentation preview, not a release input.
- The Windows 11 Ribbon preview is `assets/toolbar/windows11-ribbon/info/preview.png`.
- Generated CI reports contain contact sheets, a human-readable summary and structured resource-diff JSON, including original/patched hashes, expected-change classification, PE verification and functional test status.
- The Windows 11 Ribbon contact sheet decodes all 15 source DIBs into RGBA pixels before Sharp rendering, including the 32-bit color bitmaps and the 1-bit monochrome bitmap. The 32-bit resources declare two extra image bytes; the renderer reads only the validated scanline pixel array and leaves each source payload unchanged.
- Manually inspect the patched `7zFM.exe` Ribbon appearance on Windows at normal and high DPI, and check representative filetypes in Explorer.
- Historical artwork inventories and exact duplicate-hash evidence are in `docs/asset-inventory.md` and `docs/asset-duplicates.csv`. Do not delete unique artwork merely because it is outside the current release matrix.

## Scheduled upstream compatibility PRs

`.github/workflows/check-upstream.yml` checks the official `ip7z/7zip` **latest stable** GitHub release daily at 08:00 UTC and on `workflow_dispatch`. It compares version and official asset digests with `config/7zip.lock.json`. The read-only checker prepares a proposed lock file and uploads it as a short-lived Actions artifact only when an update is needed.

A separate, narrowly scoped job downloads the proposed lock file and uses the repository's built-in `GITHUB_TOKEN` to create or update one PR on `update/7zip-<version>` to `master`. This job does not install dependencies or execute the upstream-checking Node scripts with its write-capable token. Resource IDs require a separate reviewed change; never auto-merge compatibility PRs.

**Repository setup (no custom secrets or GitHub App):**

1. Under **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. The PR job explicitly requests `contents: write` and `pull-requests: write`; the upstream-checking job has `contents: read` only.
2. GitHub may hold `pull_request` CI runs triggered by the built-in token in an approval-required state. Open each bot-created PR and select **Approve workflows to run** when prompted. This approval starts CI; it does not merge the PR.
3. Protect `master` with required PR checks for the Windows build and **ClamAV**, prevent direct pushes and force pushes, and require passing checks before merging. Ensure the status-check sources and names match the actual CI runs. A PR without completed required checks must not be merged.

The checker must remain idempotent: no duplicate PRs for the same upstream release, no changes for the currently pinned version. An incompatible update should fail PR CI with diagnostics rather than publish a package.

## CI acceptance and malware scan

- `.github/workflows/ci.yml` builds and tests PR changes using Windows x86/x64 7-Zip binaries. The requirements include Node tests, PE/resource integrity, package matrix completeness, runtime archive smoke tests and generated visual reports.
- `.github/actions/build-verify/action.yml` is the shared Windows build, test, package and report sequence used by PR CI and release validation; keep the checks, malware scan input and output artifact semantics identical in both callers. The executable project runtime remains Node.js 22 even though current GitHub actions use Node.js 24 internally.
- The PR workflow runs for **all** PRs against `master` without path filters; required CI checks must never be skipped for docs-only PRs.
- `scripts/gui-smoke.ps1` runs on the hosted Windows runner after package verification. On x86/x64 it tests the official baseline and native Ribbon with the official DLL and each themed DLL, opens Tools → Options with the command ID derived from the pinned executable's `RT_MENU` resource, and uses UI Automation to discover the Options window and its `SysTabControl32`. This 7-Zip control is exposed as a Pane without TabItem or SelectionItem patterns, so `SendMessageW` sends its standard left/right key messages to navigate; `TCM_GETCURSEL` independently verifies each selected index, while UI Automation reads the active page. The test checks that File Manager survives every selection, invokes Cancel without saving, and verifies process cleanup. The script does not automate Ribbon appearance, Explorer filetype appearance, or high-DPI rendering.
- `scripts/integration.mjs` checks every 7z.dll icon group, IDs 0–26, on x86 and x64 for all three filetype themes. Windows `LoadImageW` loads each group at 16, 32, 48 and 256 pixels; group 0 is loaded by its named resource string, while groups 1–26 use numeric resource IDs. PE graph validation separately verifies every group-to-image reference.
- `.github/workflows/clamav-scan.yml` is a reusable mandatory Windows x64 ClamAV gate for PR checks and release validation. It scans the exact build artifact uploaded by the Windows build job and does not rebuild packages.
- `scripts/setup-clamav-windows.ps1` downloads the official portable ClamAV 1.5.4 Windows x64 ZIP into ignored local build/cache directories and verifies its pinned SHA-256 and size. It makes no system-wide changes.
- The scanner updates signatures with `freshclam.exe` using isolated configuration and database directories, verifies signed `main`, `daily`, and `bytecode` databases, and requires the daily database to be no older than 48 hours. CDN throttling, update failures, missing or stale signatures, and unverified databases fail without scanning.
- The scanner enforces the eight generated PE binaries and eight distribution archives, checks each packaged binary against its raw build output, and scans all 16 inputs with archive scanning enabled. Scanner errors, detections, warnings and incomplete scan counts fail closed.
- `clamav-report-<commit>` records the engine and signature versions, timestamps, scanned artifact SHA-256 hashes, file counts and verdict; the report is uploaded even if setup or scanning fails.
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
