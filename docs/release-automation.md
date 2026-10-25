# Release automation

The repository checks official 7-Zip releases daily, builds theme packages from pinned Windows installers, and publishes versioned GitHub Releases. The Node.js and PowerShell build tools are a complete rewrite that uses the original icon and Ribbon artwork from the earlier theme project.

## Current process

1. **Check upstream.** `.github/workflows/check-upstream.yml` compares the latest stable `ip7z/7zip` release and its official asset hashes with `config/7zip.lock.json`.
2. **Create the update PR.** A separate job uses `GITHUB_TOKEN` to propose the pinned release, without running project code with write permission.
3. **Approve CI when requested.** GitHub puts the `pull_request` workflow for a PR created by `GITHUB_TOKEN` into an approval-required state. A maintainer selects **Approve workflows to run**.
4. **Check the packages.** Required PR jobs build and test Windows x86/x64 packages, run File Manager smoke tests, and scan the exact resulting files with ClamAV.
5. **Merge the PR.** The `master` ruleset requires both checks; no PR review is currently required. A maintainer merges after reviewing the result.
6. **Validate the release.** A push to `master` starts `.github/workflows/release.yml`. Its preflight checks whether the version/revision tag is new. For an eligible release, Windows validation and ClamAV run again against the merged commit.
7. **Approve publication.** The `publish` job waits for the protected GitHub Environment named `release`. The owner approves that deployment. The publisher verifies the current commit, checksums, scanned files, and tag before uploading.

The versioned tag is `7zip-<upstream>-theme.<revision>`. `config/release.json` sets `themeRevision`. A complete release with the same tag is a no-op; never move an existing tag to another commit. Documentation-only commits do not publish a replacement release.

## Enable automatic compatibility PR merging

**Keep the required Windows build and ClamAV checks.** Changing branch protection alone will not start CI or turn on auto-merge for new PRs.

There are two distinct problems to solve:

- **CI approval:** GitHub requires approval before running `pull_request` workflows created by `GITHUB_TOKEN`. Using `workflow_dispatch` as a replacement does not satisfy pull-request status checks required by the `master` ruleset. See [GitHub's token-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) and [required-check event rules](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
- **Auto-merge:** Enabling **Settings → General → Pull Requests → Allow auto-merge** permits auto-merge on individual PRs. The maintenance workflow must also explicitly enable it on each created PR, for example `gh pr merge <number> --auto --squash`. The required checks still decide whether the PR may merge.

For an unattended update PR with the existing required checks, use a **GitHub App installation token** or **fine-grained personal access token** to create the PR. That token, unlike `GITHUB_TOKEN`, triggers ordinary `pull_request` CI without the bot-specific workflow approval.

### Recommended GitHub App setup

1. Create a GitHub App and install it only on `mwyau/7-Zip-Filetype-Theme`. Give it repository **Contents: read/write** and **Pull requests: read/write**. Keep its permissions narrow.
2. Set Actions variable `APP_ID` and secret `APP_PRIVATE_KEY`. Replace the `GITHUB_TOKEN` in the *PR-creation job* with an installation token from `actions/create-github-app-token`. Do not expose the App token to the upstream-checking job or to PR CI.
3. Enable **Allow auto-merge** in repository Settings → General. Keep the `master` ruleset requiring both existing checks, up-to-date status, and a PR; do not add a bypass for the automation.
4. After `peter-evans/create-pull-request` reports the PR number, enable auto-merge on that PR with the installation token. This should not merge a PR whose required checks are pending or failing.
5. Verify the next update PR starts Windows and ClamAV checks without a workflow-approval banner, auto-merges only after both checks succeed, and triggers the release workflow on `master`.

A fine-grained PAT stored as `UPSTREAM_PR_TOKEN` is another option. Restrict it to this repository and the same Contents/Pull requests permissions. It expires and is tied to an account; a GitHub App is better suited to unattended maintenance.

**Do not turn on automatic merging in the workflow before changing the PR-creation token and verifying the normal CI run.** The current `GITHUB_TOKEN` configuration can already open PRs, but cannot complete the CI-and-merge sequence without human approval.

## Keep the publication approval for the next release

The desired trial sequence is:

`upstream release → PR → Windows checks → ClamAV → auto-merge → master release checks → ClamAV → owner approves release → publish`

The `release` Environment must require `mwyau` as a reviewer and disable administrator bypass. The script `scripts/verify-release-environment.mjs` checks that policy before publication and again inside the publishing job. Leave both checks in place during the automatic-merge trial.

After a successful end-to-end trial, fully automatic publication requires **two coordinated changes**:

1. Remove the required reviewer from the `release` Environment (or switch to an unprotected release environment).
2. Modify or remove the script's required-reviewer verification in `approval_config` and `publish`. Removing the Environment reviewer alone will make the current workflow fail.

Keep Windows validation, ClamAV, current-`master` verification, immutable tags, and checksums regardless of publication approval.

## Release files and notes

Each release contains the four theme choices in x86/x64 builds (eight `.7z` files), `SHA256SUMS.txt`, and `build-provenance.json`.

- The filetype archives contain a patched `7z.dll`; the Windows 11 Ribbon archives contain a patched `7zFM.exe`.
- Each archive includes the official 7-Zip license. The archives are replacements for a matching official installation, not installers.
- Asset labels and release notes are generated by `scripts/publish-release.ps1` for **new releases**. Existing published releases are not rewritten when this script changes.

To update the text of an already published release, use its **Edit release** page and update the title or notes. Editing the notes does not require deleting assets or changing the tag. Avoid replacing published binaries solely to change their display labels.
