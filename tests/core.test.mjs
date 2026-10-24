import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { sha256, verifyAsset, validateManifest, parseRes, inspectDib, parseIco, parseGroupIcon, buildGroupIcon, allocateIconImages, validateIconResourceGraph, validateResourceOperations, parseVersionInfo, findMenuCommand, diffResourceMaps, readJson } from '../scripts/core.mjs';
import { compareVersions, lockNeedsUpdate, parseVersion, publicationAction, releaseTag, selectReleaseAssets } from '../scripts/upstream.mjs';
import { decodeDib, generateVisualReports, markWindowsIntegrationPassed } from '../scripts/reports.mjs';
import { validateReleaseEnvironment } from '../scripts/verify-release-environment.mjs';

const root = path.resolve(import.meta.dirname, '..');
function createDib({ width, height, bitsPerPixel, pixels, palette = [] }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(width, 4); header.writeInt32LE(height, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(bitsPerPixel, 14); header.writeUInt32LE(pixels.length, 20);
  header.writeUInt32LE(palette.length, 32);
  return Buffer.concat([header, ...palette.map((entry) => Buffer.from(entry)), pixels]);
}
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
  const [major, minor] = parseVersion(lock.version);
  const newerVersion = `${major + 1}.${String(minor).padStart(2, '0')}`;
  const olderVersion = `${major - 1}.${String(minor).padStart(2, '0')}`;
  assert.equal(lockNeedsUpdate(lock, { ...same, version: newerVersion }), true);
  assert.equal(lockNeedsUpdate(lock, { ...same, version: olderVersion }), false);
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
    assert.equal(entry.dib.bitsPerPixel, id === 190 ? 1 : 32);
    assert.equal(entry.dib.compression, 0);
    assert.ok(entry.dib.pixelBytes > 0);
    assert.equal(entry.dib.extraDeclaredImageBytes, id === 190 ? 0 : 2);
    assert.equal(entry.dib.trailingBytes, 0);
  }
});
test('DIB validation rejects a declared image size beyond the supplied payload', () => {
  const dib = Buffer.alloc(44);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(1, 4); dib.writeInt32LE(1, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14); dib.writeUInt32LE(0, 16); dib.writeUInt32LE(12, 20);
  assert.throws(() => inspectDib(dib), /pixel array exceeds payload boundary/);
  dib.writeUInt32LE(0, 20);
  assert.equal(inspectDib(dib).pixelBytes, 4);
});
test('DIB decoding preserves BGRA channels and handles bottom-up and top-down rows', () => {
  const bottomUp = createDib({ width: 1, height: 2, bitsPerPixel: 32, pixels: Buffer.from([
    0x11, 0x22, 0x33, 0x44,
    0xaa, 0xbb, 0xcc, 0xdd,
  ]) });
  assert.deepEqual(decodeDib(bottomUp).data, Buffer.from([
    0xcc, 0xbb, 0xaa, 0xdd,
    0x33, 0x22, 0x11, 0x44,
  ]));

  const topDown = createDib({ width: 1, height: -2, bitsPerPixel: 32, pixels: Buffer.from([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]) });
  assert.deepEqual(decodeDib(topDown).data, Buffer.from([3, 2, 1, 4, 7, 6, 5, 8]));
});
test('1-bit DIB decoding respects palette order, MSB-first pixels, row padding, and orientation', () => {
  const dib = createDib({
    width: 3, height: 2, bitsPerPixel: 1,
    palette: [[10, 20, 30, 0], [40, 50, 60, 0]],
    // Positive height stores the bottom row first. Three bytes after each bit byte are padding.
    pixels: Buffer.from([0x40, 0xff, 0xff, 0xff, 0xa0, 0, 0, 0]),
  });
  const color0 = [30, 20, 10, 255], color1 = [60, 50, 40, 255];
  assert.deepEqual(decodeDib(dib).data, Buffer.from([...color1, ...color0, ...color1, ...color0, ...color1, ...color0]));
});
test('all Ribbon DIBs decode into complete pixel buffers without changing their source payloads', async () => {
  const manifest = readJson(path.join(root, 'config/themes.json'));
  assert.equal(manifest.ribbon.bitmaps.length, 15);
  for (const id of manifest.ribbon.bitmaps) {
    const source = fs.readFileSync(path.join(root, manifest.ribbon.artwork, `Bitmap${id}.res`));
    const entry = parseRes(source, id), original = Buffer.from(entry.bin), decoded = decodeDib(entry.bin);
    const expectedWidth = entry.bin.readInt32LE(4), expectedHeight = Math.abs(entry.bin.readInt32LE(8));
    assert.equal(decoded.width, expectedWidth, `Bitmap ${id} width`);
    assert.equal(decoded.height, expectedHeight, `Bitmap ${id} height`);
    assert.equal(decoded.data.length, decoded.width * decoded.height * 4, `Bitmap ${id} pixel count`);
    assert.ok(new Set(Array.from({ length: decoded.width * decoded.height }, (_, index) => decoded.data.subarray(index * 4, index * 4 + 4).toString('hex'))).size > 1, `Bitmap ${id} has decoded pixel colors`);
    const png = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels } }).png().toBuffer();
    const pngMetadata = await sharp(png).metadata();
    assert.equal(pngMetadata.width, expectedWidth, `Bitmap ${id} PNG width`);
    assert.equal(pngMetadata.height, expectedHeight, `Bitmap ${id} PNG height`);
    assert.deepEqual(await sharp(png).raw().toBuffer(), decoded.data, `Bitmap ${id} pixel data round-trips through PNG`);
    assert.deepEqual(entry.bin, original, `Bitmap ${id} resource payload remains unchanged`);
  }
});
test('ICO parser preserves all source image payloads and validates every mapped theme file', () => {
  const manifest = readJson(path.join(root, 'config/themes.json'));
  const counts = {};
  const uniquePayloadCounts = {};
  for (const theme of manifest.filetypes) {
    const payloads = [];
    let count = 0;
    for (const [groupId, filename] of theme.groups) {
      const images = parseIco(fs.readFileSync(path.join(root, theme.artwork, filename)), `${theme.slug}/${filename}`);
      count += images.length;
      payloads.push(...images.map((image) => image.bin.toString('hex')));
      assert.ok(images.every((image) => image.bin.length === image.bytesInRes));
      assert.ok(images.every((image) => image.info.width > 0 && image.info.height > 0));
      for (const size of [16, 32, 48, 256]) assert.ok(images.some((image) => image.info.width === size && image.info.height === size), `${theme.slug} icon group ${groupId} contains ${size}x${size}`);
      assert.equal(groupId >= 0 && groupId < 27, true);
    }
    counts[theme.slug] = count;
    uniquePayloadCounts[theme.slug] = new Set(payloads).size;
  }
  assert.deepEqual(counts, { windows10: 215, fluent: 108, 'fluent-blue': 108 });
  assert.deepEqual(uniquePayloadCounts, { windows10: 215, fluent: 103, 'fluent-blue': 101 });
  const ico = fs.readFileSync(path.join(root, manifest.filetypes[1].artwork, manifest.filetypes[1].groups[0][1]));
  assert.throws(() => parseIco(ico.subarray(0, ico.length - 1)), /invalid ICO image directory entry|truncated or empty/);
  assert.throws(() => parseIco(Buffer.alloc(6)), /invalid ICONDIR/);
});
test('group icon parsing and construction keeps numeric image ordinals and rejects malformed graphs', () => {
  const image = { widthByte: 48, heightByte: 48, colorCount: 0, reserved: 0, planes: 1, bitsPerPixel: 32, bytesInRes: 123, id: 21 };
  const group = buildGroupIcon([image]);
  assert.deepEqual(parseGroupIcon(group), [image]);
  const duplicate = Buffer.alloc(6 + 28);
  group.copy(duplicate, 0, 0, 20); group.copy(duplicate, 20, 6, 20);
  duplicate.writeUInt16LE(2, 4);
  assert.throws(() => parseGroupIcon(duplicate), /duplicate RT_ICON ID/);
  assert.throws(() => parseGroupIcon(group.subarray(0, group.length - 1)), /malformed GRPICONDIR/);
  assert.throws(() => buildGroupIcon([{ ...image, id: 0 }]), /Invalid or duplicate RT_ICON ID/);
});
test('icon image allocation deduplicates exact bytes and skips occupied IDs', () => {
  const allocated = allocateIconImages([Buffer.from('alpha'), Buffer.from('beta'), Buffer.from('alpha')], [1, 3]);
  assert.deepEqual(allocated.ids, [2, 4, 2]);
  assert.equal(allocated.duplicatePayloadCount, 1);
  assert.deepEqual(allocated.images.map((image) => image.id), [2, 4]);
  assert.throws(() => allocateIconImages([Buffer.from('a')], [0]), /Invalid reserved RT_ICON ID/);
});
test('icon resource graph validation rejects dangling references and orphan images', () => {
  const group = buildGroupIcon([{ widthByte: 16, heightByte: 16, colorCount: 0, reserved: 0, planes: 1, bitsPerPixel: 32, bytesInRes: 4, id: 1 }]);
  assert.throws(() => validateIconResourceGraph([{ type: 14, id: 1, lang: 1033, bin: group }]), /Dangling RT_ICON reference 3:1:1033/);
  assert.throws(() => validateIconResourceGraph([{ type: 3, id: 1, lang: 1033, bin: Buffer.from([1]) }]), /Orphan RT_ICON resource/);
});
test('native resource operation plans reject duplicate keys, unsupported types, bad IDs and empty payloads', () => {
  const operations = validateResourceOperations([
    { type: 14, id: '0', language: 1033, action: 'update', bin: Buffer.from([1, 2]) },
    { type: 3, id: 11, language: 1033, action: 'delete', bin: null },
  ]);
  assert.equal(operations.length, 2);
  assert.throws(() => validateResourceOperations([
    { type: 3, id: 1, language: 1033, action: 'delete', bin: null },
    { type: 3, id: 1, language: 1033, action: 'update', bin: Buffer.from([1]) },
  ]), /Duplicate native resource operation/);
  assert.throws(() => validateResourceOperations([{ type: 16, id: 1, language: 1033, action: 'delete', bin: null }]), /Unsupported native resource type/);
  assert.throws(() => validateResourceOperations([{ type: 3, id: 65536, language: 1033, action: 'delete', bin: null }]), /Invalid numeric resource ordinal/);
  assert.throws(() => validateResourceOperations([{ type: 14, id: 0, language: 1033, action: 'delete', bin: null }]), /cannot distinguish ordinal zero/);
  assert.throws(() => validateResourceOperations([{ type: 3, id: 1, language: 1033, action: 'update', bin: Buffer.alloc(0) }]), /requires nonempty binary data/);
  assert.throws(() => validateResourceOperations([{ type: 3, id: 1, language: 1033, action: 'delete', bin: Buffer.from([1]) }]), /must not include payload data/);
});
test('VERSIONINFO parser reads a verified VS_FIXEDFILEINFO', () => {
  const version = Buffer.alloc(92);
  version.writeUInt16LE(version.length, 0); version.writeUInt16LE(52, 2); version.writeUInt16LE(0, 4);
  Buffer.from('VS_VERSION_INFO\0', 'utf16le').copy(version, 6);
  const fixed = 40;
  version.writeUInt32LE(0xfeef04bd, fixed); version.writeUInt32LE(0x00010000, fixed + 4);
  version.writeUInt32LE((26 << 16) | 4, fixed + 8); version.writeUInt32LE(0, fixed + 12);
  assert.deepEqual(parseVersionInfo(version), { fileVersionMS: (26 << 16) | 4, fileVersionLS: 0 });
  version.writeUInt32LE(0, fixed);
  assert.throws(() => parseVersionInfo(version), /VS_FIXEDFILEINFO signature/);
});
test('pinned MENUEX Tools > Options item resolves to its verified numeric command ID', () => {
  const menu = Buffer.alloc(128);
  let offset = 12;
  menu.writeUInt16LE(1, 0); menu.writeUInt16LE(4, 2); menu.writeUInt32LE(0, 4);
  menu.writeUInt32LE(0, offset); menu.writeUInt32LE(0, offset + 4); menu.writeUInt32LE(504, offset + 8); menu.writeUInt16LE(0x81, offset + 12); offset += 14;
  Buffer.from('&Tools\0', 'utf16le').copy(menu, offset); offset += Buffer.byteLength('&Tools\0', 'utf16le');
  offset = (offset + 3) & ~3; menu.writeUInt32LE(0, offset); offset += 4;
  menu.writeUInt32LE(0, offset); menu.writeUInt32LE(0, offset + 4); menu.writeUInt32LE(900, offset + 8); menu.writeUInt16LE(0x80, offset + 12); offset += 14;
  Buffer.from('&Options...\0', 'utf16le').copy(menu, offset); offset += Buffer.byteLength('&Options...\0', 'utf16le');
  assert.equal(findMenuCommand(menu.subarray(0, offset), 'Tools', 'Options...'), 900);
  assert.throws(() => findMenuCommand(menu.subarray(0, offset - 2), 'Tools', 'Options...'));
});
test('resource diff classifies added, removed, and replaced payloads', () => {
  const before = new Map([['3:1:1033', Buffer.from('old')], ['3:2:1033', Buffer.from('keep')]]);
  const after = new Map([['3:1:1033', Buffer.from('new')], ['3:3:1033', Buffer.from('added')], ['3:2:1033', Buffer.from('keep')]]);
  const changes = diffResourceMaps(before, after, (key) => key === '3:1:1033');
  assert.deepEqual(changes.map((x) => [x.id, x.change, x.classification]), [[1, 'replaced', 'expected'], [3, 'added', 'unexpected']]);
  const named = diffResourceMaps(new Map([['14:s0:1033', Buffer.from('old')]]), new Map([['14:s0:1033', Buffer.from('new')]]));
  assert.deepEqual([named[0].type, named[0].id, named[0].idType, named[0].language], [14, '0', 'name', 1033]);
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
    const ribbon = files.find((file) => path.basename(file) === 'windows11-ribbon.png');
    const { data, info } = await sharp(ribbon).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 7 * 172);
    assert.equal(info.height, 32 + 3 * 150);
    const manifest = readJson(path.join(root, 'config/themes.json'));
    for (const [index, id] of manifest.ribbon.bitmaps.entries()) {
      const originX = (index % 7) * 172 + 30, originY = 32 + Math.floor(index / 7) * 150 + 8;
      let paintedPixels = 0;
      for (let y = originY; y < originY + 96; y++) for (let x = originX; x < originX + 112; x++) {
        const pixel = (y * info.width + x) * info.channels;
        if (data[pixel] !== 231 || data[pixel + 1] !== 233 || data[pixel + 2] !== 236) paintedPixels++;
      }
      assert.ok(paintedPixels > 10, `Ribbon bitmap ${id} is visible in its contact-sheet tile`);
    }
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
