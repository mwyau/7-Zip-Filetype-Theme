import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, verifyAsset, validateManifest, parseRes, diffResourceMaps, readJson } from '../scripts/core.mjs';
import { compareVersions, lockNeedsUpdate, parseVersion, publicationAction, releaseTag, selectReleaseAssets } from '../scripts/upstream.mjs';
import { generateVisualReports, markWindowsIntegrationPassed } from '../scripts/reports.mjs';
import { validateReleaseEnvironment } from '../scripts/verify-release-environment.mjs';

const root = path.resolve(import.meta.dirname, '..');
test('strict numeric stable-version parsing and ordering', () => {
  assert.deepEqual(parseVersion('26.04'), [26, 4]);
  assert.equal(compareVersions('26.10', '26.04'), 6);
  assert.equal(compareVersions('26.04', '26.04'), 0);
  for (const invalid of ['v26.04', '26', '26.4.1', '26.04-beta', '']) assert.throws(() => parseVersion(invalid));
});
test('official release selection requires exact x86/x64 assets and SHA-256 digests', () => {
  const mk = (name) => ({ name, browser_download_url: `https://github.com/ip7z/7zip/releases/download/26.05/${name}`, size: 123, digest: `sha256:${'a'.repeat(64)}` });
  const release = { id: 42, tag_name: '26.05', html_url: 'https://github.com/ip7z/7zip/releases/tag/26.05', draft: false, prerelease: false, assets: [mk('7z2605.exe'), mk('7z2605-x64.exe'), mk('7zr.exe')] };
  const selected = selectReleaseAssets(release);
  assert.deepEqual(Object.keys(selected.assets), ['x86', 'x64']); assert.equal(selected.extractor.sha256, 'a'.repeat(64));
  assert.throws(() => selectReleaseAssets({ ...release, prerelease: true }));
  assert.throws(() => selectReleaseAssets({ ...release, assets: release.assets.slice(0, 1) }));
});
test('lock update decision handles no update, same-version digest change, and newer release', () => {
  const lock = readJson(path.join(root, 'config/7zip.lock.json'));
  const same = { ...lock, assets: { ...lock.assets } };
  assert.equal(lockNeedsUpdate(lock, same), false);
  const changed = structuredClone(same); changed.assets.x86.sha256 = 'f'.repeat(64);
  assert.equal(lockNeedsUpdate(lock, changed), true);
  const extractorChanged = structuredClone(same); extractorChanged.extractor.sha256 = 'e'.repeat(64);
  assert.equal(lockNeedsUpdate(lock, extractorChanged), true);
  const releaseReplaced = structuredClone(same); releaseReplaced.releaseId += 1;
  assert.equal(lockNeedsUpdate(lock, releaseReplaced), true);
  assert.equal(lockNeedsUpdate(lock, { ...same, version: '26.05' }), true);
  assert.equal(lockNeedsUpdate(lock, { ...same, version: '26.03' }), false);
});
test('SHA-256 verification checks exact byte count and content', () => {
  const data = Buffer.from('fixture'); const expected = { size: data.length, sha256: sha256(data) };
  assert.equal(verifyAsset(data, expected), expected.sha256);
  assert.throws(() => verifyAsset(data, { ...expected, size: 99 }));
  assert.throws(() => verifyAsset(data, { ...expected, sha256: '0'.repeat(64) }));
});
test('theme manifest covers unique IDs and existing artwork', () => {
  const manifest = readJson(path.join(root, 'config/themes.json'));
  assert.equal(validateManifest(manifest, root), true);
  const duplicate = structuredClone(manifest); duplicate.filetypes[0].groups[1][0] = 0;
  assert.throws(() => validateManifest(duplicate, root), /duplicate or invalid/);
  const missing = structuredClone(manifest); missing.filetypes[0].groups[0][1] = 'missing.ico';
  assert.throws(() => validateManifest(missing, root), /missing artwork/);
});
test('compiled Ribbon .res records extract exactly one RT_BITMAP with its language', () => {
  const manifest = readJson(path.join(root, 'config/themes.json'));
  for (const id of manifest.ribbon.bitmaps) {
    const payload = fs.readFileSync(path.join(root, manifest.ribbon.artwork, `Bitmap${id}.res`));
    const entry = parseRes(payload, id);
    assert.equal(entry.type, 2); assert.equal(entry.id, id); assert.equal(entry.lang, 1033); assert.ok(entry.bin.length > 40);
    assert.throws(() => parseRes(payload.subarray(0, payload.length - 1), id));
    assert.throws(() => parseRes(payload, id + 1));
  }
});
test('resource diff classifies added, removed, and replaced payloads', () => {
  const before = new Map([['3:1:1033', Buffer.from('old')], ['3:2:1033', Buffer.from('keep')]]);
  const after = new Map([['3:1:1033', Buffer.from('new')], ['3:3:1033', Buffer.from('added')], ['3:2:1033', Buffer.from('keep')]]);
  const changes = diffResourceMaps(before, after, (key) => key === '3:1:1033');
  assert.deepEqual(changes.map((x) => [x.id, x.change, x.classification]), [[1, 'replaced', 'expected'], [3, 'added', 'unexpected']]);
});
test('release revision tags and publication are idempotent and reject mismatched state', () => {
  const tag = releaseTag('26.04', 1); assert.equal(tag, '7zip-26.04-theme.1');
  const assets = { 'theme.7z': 'abc', 'SHA256SUMS.txt': 'def' };
  assert.equal(publicationAction({ tagExists: false, releaseExists: false, requestedAssets: assets, commit: 'a' }), 'publish');
  assert.equal(publicationAction({ tagExists: true, releaseExists: true, requestedAssets: assets, publishedAssets: assets, commit: 'a', publishedCommit: 'a' }), 'noop');
  assert.throws(() => publicationAction({ tagExists: true, releaseExists: false, requestedAssets: assets, commit: 'a' }));
  assert.throws(() => publicationAction({ tagExists: true, releaseExists: true, requestedAssets: assets, publishedAssets: { ...assets, 'theme.7z': 'different' }, commit: 'a', publishedCommit: 'a' }));
});
test('release approval guard requires the repository owner and disables administrator bypass', () => {
  const environment = { name: 'release', can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'mwyau' } }] }] };
  assert.deepEqual(validateReleaseEnvironment(environment, 'mwyau'), { environment: 'release', reviewer: 'mwyau', administratorBypass: false });
  assert.throws(() => validateReleaseEnvironment({ ...environment, can_admins_bypass: true }, 'mwyau'), /administrator bypass/);
  assert.throws(() => validateReleaseEnvironment({ ...environment, protection_rules: [] }, 'mwyau'), /repository owner/);
  assert.throws(() => validateReleaseEnvironment({ ...environment, name: 'other' }, 'mwyau'), /environment "release" is missing/);
});
test('visual report generator renders all source contact sheets without a desktop', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-report-'));
  try {
    const files = await generateVisualReports({ rootDir: root, outputDir: out });
    assert.equal(files.length, 4);
    for (const file of files) { const stat = fs.statSync(file); assert.ok(stat.size > 1000); assert.equal(fs.readFileSync(file).subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
test('Windows integration results distinguish runtime-tested filetypes from Ribbon GUI smoke', () => {
  const manifest = readJson(path.join(root, 'config/themes.json'));
  const diff = { results: [
    { theme: manifest.filetypes[0].name, functionalTests: { status: 'pending-windows-integration' } },
    { theme: manifest.filetypes[1].name, functionalTests: { status: 'pending-windows-integration' } },
    { theme: manifest.ribbon.name, functionalTests: { status: 'gui-smoke-not-automated' } },
  ] };
  const updated = markWindowsIntegrationPassed(diff, manifest);
  assert.equal(updated.results[0].functionalTests.status, 'passed-x86-x64-archive-runtime-smoke');
  assert.equal(updated.results[1].functionalTests.status, 'passed-x86-x64-archive-runtime-smoke');
  assert.equal(updated.results[2].functionalTests.status, 'passed-x86-x64-package-integrity; GUI-smoke-pending');
  assert.equal(diff.results[0].functionalTests.status, 'pending-windows-integration');
});
