import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJson, validateManifest, patchIcons, patchBitmaps, validatePe, sha256 } from './core.mjs';
import { generateVisualReports } from './reports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = readJson(path.join(root, 'config/7zip.lock.json'));
const manifest = readJson(path.join(root, 'config/themes.json'));
const release = readJson(path.join(root, 'config/release.json'));
const outRoot = path.resolve(process.env.OUTPUT_DIR || path.join(root, 'dist'));
const buildRoot = path.resolve(process.env.BUILD_DIR || path.join(root, '.build'));
validateManifest(manifest, root);
fs.rmSync(buildRoot, { recursive: true, force: true }); fs.mkdirSync(buildRoot, { recursive: true });
fs.rmSync(outRoot, { recursive: true, force: true }); fs.mkdirSync(outRoot, { recursive: true });
const extractor = spawnSync(process.execPath, [path.join(root, 'scripts/fetch-7zip.mjs')], { stdio: 'inherit', env: process.env });
if (extractor.status !== 0) process.exit(extractor.status ?? 1);
const revision = Number(process.env.THEME_REVISION || release.themeRevision);
const tag = `7zip-${lock.version}-theme.${revision}`;
const report = { upstreamVersion: lock.version, releaseId: lock.releaseId, tag, artifacts: [], results: [] };
const expectedMachines = { x86: 0x014c, x64: 0x8664 };
for (const [arch, asset] of Object.entries(lock.assets)) {
  const source = path.join(buildRoot, 'upstream', arch);
  const fm = fs.readFileSync(path.join(source, '7zFM.exe'));
  for (const theme of manifest.filetypes) {
    const original = fs.readFileSync(path.join(source, '7z.dll'));
    const patched = patchIcons(original, theme, manifest.resourceLanguage);
    if (patched.machine !== expectedMachines[arch]) throw new Error(`${arch}/${theme.slug}: wrong PE machine`);
    const validation = validatePe(patched.output, expectedMachines[arch], lock.version);
    const unexpected = patched.changes.filter((item) => item.classification !== 'expected');
    if (unexpected.length) throw new Error(`${arch}/${theme.slug}: unexpected resource changes: ${JSON.stringify(unexpected)}`);
    const name = `${theme.slug}-${arch}.7z`;
    const stage = path.join(buildRoot, 'packages', arch, theme.slug); fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, '7z.dll'), patched.output);
    fs.copyFileSync(path.join(source, 'License.txt'), path.join(stage, '7-Zip-License.txt'));
    const diff = { upstreamVersion: lock.version, releaseId: lock.releaseId, architecture: arch, theme: theme.name, inputSha256: sha256(original), outputSha256: sha256(patched.output), changes: patched.changes, peValidation: validation, functionalTests: { status: 'pending-windows-integration' } };
    report.results.push(diff);
    report.artifacts.push(await packageFolder(stage, name, outRoot, source, arch, theme.slug));
  }
  const ribbon = manifest.ribbon;
  const ribbonPatch = patchBitmaps(fm, (id) => path.join(root, ribbon.artwork, `Bitmap${id}.res`), ribbon.bitmaps, manifest.resourceLanguage);
  if (ribbonPatch.machine !== expectedMachines[arch]) throw new Error(`${arch}/${ribbon.slug}: wrong PE machine`);
  const unexpected = ribbonPatch.changes.filter((item) => item.classification !== 'expected');
  if (unexpected.length) throw new Error(`${arch}/${ribbon.slug}: unexpected resource changes: ${JSON.stringify(unexpected)}`);
  const stage = path.join(buildRoot, 'packages', arch, ribbon.slug); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, '7zFM.exe'), ribbonPatch.output);
  fs.copyFileSync(path.join(source, 'License.txt'), path.join(stage, '7-Zip-License.txt'));
  report.results.push({ upstreamVersion: lock.version, releaseId: lock.releaseId, architecture: arch, theme: ribbon.name, inputSha256: sha256(fm), outputSha256: sha256(ribbonPatch.output), changes: ribbonPatch.changes, peValidation: validatePe(ribbonPatch.output, expectedMachines[arch], lock.version), functionalTests: { status: 'gui-smoke-not-automated' } });
  report.artifacts.push(await packageFolder(stage, `${ribbon.slug}-${arch}.7z`, outRoot, source, arch, ribbon.slug));
}
fs.mkdirSync(path.join(root, 'reports/generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports/generated/resource-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'reports/generated/build-provenance.json'), `${JSON.stringify({ upstream: lock, tag, node: process.version, sourceCommit: process.env.GITHUB_SHA || null, artifacts: report.artifacts }, null, 2)}\n`);
await generateVisualReports({ rootDir: root, outputDir: path.join(root, 'reports/generated') });
console.log(`Built ${report.artifacts.length} archives for ${tag}`);

async function packageFolder(folder, name, outputDirectory, upstream, arch, theme) {
  const executable = path.join(upstream, '7z.exe');
  if (process.platform !== 'win32') throw new Error('Release .7z packaging requires the verified 7z.exe from the official Windows toolchain; run on a Windows runner.');
  const archive = path.join(outputDirectory, name); fs.mkdirSync(outputDirectory, { recursive: true });
  const proc = spawnSync(executable, ['a', '-t7z', '-mx=9', '-mtm=off', '-mtc=off', '-mta=off', archive, '.'], { cwd: folder, windowsHide: true, encoding: 'utf8' });
  if (proc.error || proc.status !== 0) throw new Error(`7z packaging failed for ${theme}/${arch}: ${proc.error?.message || proc.stderr}`);
  const list = spawnSync(executable, ['l', '-slt', archive], { windowsHide: true, encoding: 'utf8' });
  if (list.status !== 0) throw new Error(`Cannot verify package ${name}`);
  const listed = list.stdout.split(/\r?\n/).filter((line) => line.startsWith('Path = ')).slice(1).map((line) => line.slice(7)).sort();
  const expected = fs.readdirSync(folder).sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) throw new Error(`${name}: archive file list mismatch (${listed} != ${expected})`);
  return { file: name, sha256: sha256(fs.readFileSync(archive)), size: fs.statSync(archive).size, architecture: arch, theme };
}
