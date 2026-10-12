import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as PE from 'pe-library';
import { readJson } from './core.mjs';

if (process.platform !== 'win32') throw new Error('Windows archive integration tests require a Windows runner.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = readJson(path.join(root, 'config/7zip.lock.json'));
const manifest = readJson(path.join(root, 'config/themes.json'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), '7zip-theme-test-'));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const moduleInspector = path.join(root, 'scripts/assert-loaded-7z-dll.ps1');
const iconLoader = path.join(root, 'scripts/icon-load-smoke.ps1');
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(' ')} failed (exit ${result.status}): ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}

function runExpectFailure(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status === 0) throw new Error(`${path.basename(bin)} unexpectedly accepted invalid input: ${args.join(' ')}`);
  return result;
}

function pseudoRandomBytes(length, seed = 0x7a1b2c3d) {
  const buffer = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    buffer[index] = state & 0xff;
  }
  return buffer;
}

function createFixture(sourceDir) {
  const files = new Map([
    ['root.txt', Buffer.from('7-Zip theme native integration fixture\n', 'utf8')],
    ['nested/level-one/level-two/Δοκιμή-資料.bin', pseudoRandomBytes(96 * 1024)],
    ['nested/level-one/notes-二.txt', Buffer.from('nested text file\nsecond line\n', 'utf8')],
    ['unicodé/文件 名称.txt', Buffer.from('Unicode paths and content: café, 日本語, Ελληνικά\n', 'utf8')],
    ['empty/zero-byte.dat', Buffer.alloc(0)],
  ]);
  for (const [relative, bytes] of files) {
    const target = path.join(sourceDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const paths = new Set(files.keys());
  for (const relative of files.keys()) {
    let parent = path.posix.dirname(relative);
    while (parent !== '.') { paths.add(parent); parent = path.posix.dirname(parent); }
  }
  return { files, paths };
}

function collectFiles(folder, prefix = '') {
  const found = new Map();
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      for (const [childPath, childFile] of collectFiles(fullPath, relative)) found.set(childPath, childFile);
    } else if (entry.isFile()) found.set(relative.replaceAll('\\', '/'), fullPath);
    else throw new Error(`Unexpected non-file in extraction output: ${fullPath}`);
  }
  return found;
}

function normalizeListedPath(value) {
  let normalized = value.replaceAll('\\', '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.replace(/^\.\//, '');
}

function verifyListing(listing, archive, fixture, label) {
  const listed = listing.split(/\r?\n/).filter((line) => line.startsWith('Path = ')).map((line) => normalizeListedPath(line.slice(7)));
  const archivePath = normalizeListedPath(path.resolve(archive));
  const itemPaths = new Set(listed.filter((item) => item !== archivePath));
  const missing = [...fixture.paths].filter((relative) => !itemPaths.has(relative));
  const extras = [...itemPaths].filter((relative) => !fixture.paths.has(relative));
  if (missing.length || extras.length) throw new Error(`${label}: archive path list differs from fixture (missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extras)})`);
}

function verifyExtracted(outDir, fixture, label) {
  const extracted = collectFiles(outDir);
  const actualPaths = [...extracted.keys()].sort();
  const expectedPaths = [...fixture.files.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`${label}: extracted relative paths differ (expected=${JSON.stringify(expectedPaths)}, actual=${JSON.stringify(actualPaths)})`);
  for (const [relative, expected] of fixture.files) {
    const target = extracted.get(relative);
    const actual = fs.readFileSync(target);
    if (actual.length !== expected.length || digest(target) !== crypto.createHash('sha256').update(expected).digest('hex')) {
      throw new Error(`${label}: extracted size or SHA-256 mismatch for ${relative}`);
    }
  }
}

function assertLoadedThemeDll(cli, workingDirectory, expectedDll, label) {
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', moduleInspector,
    '-Executable', cli, '-WorkingDirectory', workingDirectory, '-ExpectedDll', expectedDll,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${label}: could not prove 7z.exe loaded the staged themed DLL: ${result.error?.message || result.stderr || result.stdout}`);
  console.log(`${label}: ${result.stdout.trim()}`);
}

function assertThemeIconsLoad(dll, label) {
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', iconLoader, '-Dll', dll,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${label}: Windows LoadImageW could not load all 27 icon groups at the requested sizes: ${result.error?.message || result.stderr || result.stdout}`);
  console.log(`${label}: ${result.stdout.trim()}`);
}

function testNativeWriterRejectsDuplicateOperations(targetExecutable, scratchRoot, label) {
  const copy = path.join(scratchRoot, `${label.replaceAll(/[^a-z0-9-]/gi, '-')}-writer-negative.exe`);
  const duplicateManifest = path.join(scratchRoot, `${label.replaceAll(/[^a-z0-9-]/gi, '-')}-duplicate-operations.json`);
  fs.copyFileSync(targetExecutable, copy);
  const before = digest(copy);
  fs.writeFileSync(duplicateManifest, `${JSON.stringify({ operations: [
    { type: 3, id: 1, language: 1033, action: 'delete' },
    { type: 3, id: 1, language: 1033, action: 'delete' },
  ] }, null, 2)}\n`);
  const result = spawnSync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/update-resources.ps1'),
    '-Executable', copy, '-Manifest', duplicateManifest,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status === 0) throw new Error(`${label}: native writer accepted duplicate resource operations.`);
  if (digest(copy) !== before) throw new Error(`${label}: native writer changed the PE after rejecting duplicate operations.`);
  console.log(`${label}: native writer rejected duplicate operations before changing the staged PE.`);

  const updateCopy = path.join(scratchRoot, `${label.replaceAll(/[^a-z0-9-]/gi, '-')}-writer-update-delete.exe`);
  const payloadDirectory = path.join(scratchRoot, `${label.replaceAll(/[^a-z0-9-]/gi, '-')}-Unicode-资源`);
  const payloadPath = path.join(payloadDirectory, 'bitmap-payload-图.bin');
  const updateManifest = path.join(scratchRoot, `${label.replaceAll(/[^a-z0-9-]/gi, '-')}-writer-update.json`);
  const deleteManifest = path.join(scratchRoot, `${label.replaceAll(/[^a-z0-9-]/gi, '-')}-writer-delete.json`);
  fs.copyFileSync(targetExecutable, updateCopy);
  fs.mkdirSync(payloadDirectory, { recursive: true });
  const payload = pseudoRandomBytes(4096, 0x12345678);
  fs.writeFileSync(payloadPath, payload);
  const readResourceMap = (file) => {
    const exe = PE.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
    return new Map(PE.NtExecutableResource.from(exe).entries.map((entry) => [`${entry.type}:${typeof entry.id}:${entry.id}:${entry.lang}`, Buffer.from(entry.bin)]));
  };
  const originalResources = readResourceMap(updateCopy);
  let resourceId = 0xffff;
  while (resourceId > 0 && originalResources.has(`2:number:${resourceId}:1033`)) resourceId--;
  if (resourceId === 0) throw new Error(`${label}: no free RT_BITMAP ordinal is available for the native writer test.`);
  const invokeWriter = (manifestFile, operationLabel) => {
    const writer = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/update-resources.ps1'),
      '-Executable', updateCopy, '-Manifest', manifestFile,
    ], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    if (writer.error || writer.status !== 0) throw new Error(`${label}: native writer ${operationLabel} failed: ${writer.error?.message || writer.stderr || writer.stdout}`);
  };

  fs.writeFileSync(updateManifest, `${JSON.stringify({ operations: [
    { type: 2, id: resourceId, language: 1033, action: 'update', path: payloadPath },
  ] }, null, 2)}\n`);
  invokeWriter(updateManifest, 'Unicode-path update');
  const afterUpdate = readResourceMap(updateCopy), updateKey = `2:number:${resourceId}:1033`;
  if (!afterUpdate.has(updateKey) || !afterUpdate.get(updateKey).equals(payload)) throw new Error(`${label}: native writer did not add the expected RT_BITMAP payload.`);
  if ([...originalResources].some(([key, value]) => !afterUpdate.has(key) || !afterUpdate.get(key).equals(value))) throw new Error(`${label}: native writer update changed an unrelated resource.`);

  fs.writeFileSync(deleteManifest, `${JSON.stringify({ operations: [
    { type: 2, id: resourceId, language: 1033, action: 'delete' },
  ] }, null, 2)}\n`);
  invokeWriter(deleteManifest, 'delete');
  const afterDelete = readResourceMap(updateCopy);
  if (afterDelete.has(updateKey) || afterDelete.size !== originalResources.size || [...originalResources].some(([key, value]) => !afterDelete.has(key) || !afterDelete.get(key).equals(value))) {
    throw new Error(`${label}: native writer delete did not restore the original resource graph.`);
  }
  console.log(`${label}: native writer updated and deleted a resource through separate transactions, using Unicode payload paths.`);
}

function verifyPackage(tool, packageFile, packageFolder, outputFolder, label) {
  run(tool, ['l', '-slt', packageFile], root);
  run(tool, ['t', packageFile], root);
  run(tool, ['x', '-y', `-o${outputFolder}`, packageFile], root);
  const expected = collectFiles(packageFolder), actual = collectFiles(outputFolder);
  if (JSON.stringify([...actual.keys()].sort()) !== JSON.stringify([...expected.keys()].sort())) throw new Error(`${label}: extracted package file list mismatch`);
  for (const [relative, expectedPath] of expected) {
    const actualPath = actual.get(relative);
    if (fs.statSync(actualPath).size !== fs.statSync(expectedPath).size || digest(actualPath) !== digest(expectedPath)) throw new Error(`${label}: package file hash mismatch for ${relative}`);
  }
}

try {
  for (const arch of Object.keys(lock.assets)) {
    const upstream = path.join(root, '.build/upstream', arch), tool = path.join(upstream, '7z.exe');
    testNativeWriterRejectsDuplicateOperations(path.join(upstream, '7zFM.exe'), temp, `${arch}-native-writer`);
    for (const theme of manifest.filetypes) {
      const themeRoot = path.join(temp, arch, theme.slug), binDir = path.join(themeRoot, 'bin'), sourceDir = path.join(themeRoot, 'source');
      const patchedDll = path.join(root, '.build/packages', arch, theme.slug, '7z.dll');
      fs.mkdirSync(binDir, { recursive: true });
      fs.copyFileSync(tool, path.join(binDir, '7z.exe')); fs.copyFileSync(patchedDll, path.join(binDir, '7z.dll'));
      const cli = path.join(binDir, '7z.exe'), stagedDll = path.join(binDir, '7z.dll');
      assertThemeIconsLoad(stagedDll, `${arch}/${theme.slug}`);
      assertLoadedThemeDll(cli, binDir, stagedDll, `${arch}/${theme.slug}`);

      const fixture = createFixture(sourceDir);
      for (const format of ['7z', 'zip']) {
        const archive = path.join(themeRoot, `fixture.${format}`), outDir = path.join(themeRoot, `out-${format}`);
        fs.mkdirSync(outDir, { recursive: true });
        run(cli, ['a', `-t${format}`, '-mx=1', archive, '.'], sourceDir);
        run(cli, ['t', archive], sourceDir);
        const listing = run(cli, ['l', '-slt', '-sccUTF-8', archive], sourceDir);
        verifyListing(listing, archive, fixture, `${arch}/${theme.slug}/${format}`);
        run(cli, ['x', '-y', `-o${outDir}`, archive], sourceDir);
        verifyExtracted(outDir, fixture, `${arch}/${theme.slug}/${format}`);
        console.log(`${arch}/${theme.slug}/${format}: nested Unicode/empty/binary fixture create, list, test, extract, size and SHA-256 passed.`);
      }

      const badArchive = path.join(themeRoot, 'invalid.7z');
      const badBytes = fs.readFileSync(path.join(themeRoot, 'fixture.7z'));
      badBytes[0] ^= 0xff;
      fs.writeFileSync(badArchive, badBytes);
      runExpectFailure(cli, ['t', badArchive], sourceDir);
      console.log(`${arch}/${theme.slug}: corrupted 7z signature was rejected.`);
    }

    for (const packageTheme of [...manifest.filetypes, manifest.ribbon]) {
      const slug = packageTheme.slug, packageFile = path.join(root, 'dist', `${slug}-${arch}.7z`);
      const packageFolder = path.join(root, '.build/packages', arch, slug);
      if (!fs.existsSync(packageFile)) throw new Error(`Missing generated package ${slug}-${arch}.7z`);
      const outputFolder = path.join(temp, 'packages', arch, slug);
      fs.mkdirSync(outputFolder, { recursive: true });
      verifyPackage(tool, packageFile, packageFolder, outputFolder, `${slug}/${arch}`);
      console.log(`${slug}/${arch}: package listing, archive test, extraction and file hashes passed.`);
    }
    console.log(`${arch}: all generated theme packages passed archive integrity checks.`);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
