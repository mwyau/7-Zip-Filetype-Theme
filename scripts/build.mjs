import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJson, validateManifest, planIconPatch, verifyIconPatch, readRibbonBitmaps, verifyRibbonBitmaps, findMenuCommandInExecutable, validatePe, sha256, validateResourceOperations } from './core.mjs';

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
if (process.platform !== 'win32') throw new Error('Native PE resource updates require the Windows Win32 resource APIs.');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const updater = path.join(root, 'scripts/update-resources.ps1');
function writeNativeManifest(stageRoot, operationList) {
  const payloadRoot = path.join(stageRoot, 'payloads'); fs.mkdirSync(payloadRoot, { recursive: true });
  const operations = operationList.map((operation) => {
    if (operation.action === 'delete') return { type: operation.type, id: operation.id, language: operation.language, action: 'delete' };
    const payload = path.join(payloadRoot, `${operation.type}-${operation.id}-${operation.language}.bin`);
    fs.writeFileSync(payload, operation.bin);
    return { type: operation.type, id: operation.id, language: operation.language, action: 'update', path: payload };
  });
  const manifestPath = path.join(stageRoot, 'operations.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({ operations }, null, 2)}\n`);
  return manifestPath;
}
function applyNativeUpdate(executable, manifestPath, label) {
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', updater, '-Executable', executable, '-Manifest', manifestPath], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Native resource update failed for ${label}: ${result.error?.message || result.stderr || result.stdout}`);
}
let optionsMenuCommand = null;
for (const arch of Object.keys(lock.assets)) {
  const source = path.join(buildRoot, 'upstream', arch);
  const fm = fs.readFileSync(path.join(source, '7zFM.exe'));
  const menuCommand = findMenuCommandInExecutable(fm, manifest.resourceLanguage, 'Tools', 'Options...');
  if (optionsMenuCommand && JSON.stringify(optionsMenuCommand) !== JSON.stringify(menuCommand)) throw new Error(`7zFM.exe ${arch} Tools > Options menu differs from the other architecture`);
  optionsMenuCommand = menuCommand;
  for (const theme of manifest.filetypes) {
    const original = fs.readFileSync(path.join(source, '7z.dll'));
    const plan = planIconPatch(original, theme, manifest.resourceLanguage, root);
    const operations = validateResourceOperations(plan.operations);
    const nativeRoot = path.join(buildRoot, 'native-icons', arch, theme.slug);
    fs.mkdirSync(nativeRoot, { recursive: true });
    const stagedDll = path.join(nativeRoot, '7z.dll');
    fs.copyFileSync(path.join(source, '7z.dll'), stagedDll);
    const operationManifest = writeNativeManifest(nativeRoot, operations);
    applyNativeUpdate(stagedDll, operationManifest, `${arch}/${theme.slug}`);
    const patched = verifyIconPatch(original, fs.readFileSync(stagedDll), plan);
    const repeatDll = path.join(nativeRoot, 'repeat.dll');
    fs.copyFileSync(path.join(source, '7z.dll'), repeatDll);
    applyNativeUpdate(repeatDll, operationManifest, `${arch}/${theme.slug} reproducibility check`);
    const repeatOutput = fs.readFileSync(repeatDll);
    verifyIconPatch(original, repeatOutput, plan);
    if (!patched.output.equals(repeatOutput)) throw new Error(`${arch}/${theme.slug}: identical native resource operations produced different DLL bytes`);
    if (patched.machine !== expectedMachines[arch]) throw new Error(`${arch}/${theme.slug}: wrong PE machine`);
    const validation = validatePe(patched.output, expectedMachines[arch], lock.version);
    const unexpected = patched.changes.filter((item) => item.classification !== 'expected');
    if (unexpected.length) throw new Error(`${arch}/${theme.slug}: unexpected resource changes: ${JSON.stringify(unexpected)}`);
    const name = `${theme.slug}-${arch}.7z`;
    const stage = path.join(buildRoot, 'packages', arch, theme.slug); fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, '7z.dll'), patched.output);
    fs.copyFileSync(path.join(source, 'License.txt'), path.join(stage, '7-Zip-License.txt'));
    const diff = { upstreamVersion: lock.version, releaseId: lock.releaseId, architecture: arch, theme: theme.name, inputSha256: sha256(original), outputSha256: sha256(patched.output), changes: patched.changes, iconResources: patched.iconResources, reproducibility: { method: 'two independent native resource transactions from the same pinned input', byteIdentical: true }, peValidation: validation, functionalTests: { status: 'pending-windows-integration-and-gui-smoke' } };
    report.results.push(diff);
    report.artifacts.push(await packageFolder(stage, name, outRoot, source, arch, theme.slug));
  }
  const ribbon = manifest.ribbon;
  const bitmapRecords = readRibbonBitmaps((id) => path.join(root, ribbon.artwork, `Bitmap${id}.res`), ribbon.bitmaps, manifest.resourceLanguage);
  const nativeRoot = path.join(buildRoot, 'native-ribbon', arch);
  fs.mkdirSync(nativeRoot, { recursive: true });
  const stagedExecutable = path.join(nativeRoot, '7zFM.exe');
  fs.copyFileSync(path.join(source, '7zFM.exe'), stagedExecutable);
  const ribbonOperations = validateResourceOperations(bitmapRecords.map((record) => ({ type: 2, id: record.id, language: record.lang, action: 'update', bin: record.bin })));
  const updateManifest = writeNativeManifest(nativeRoot, ribbonOperations);
  applyNativeUpdate(stagedExecutable, updateManifest, `${arch}/${ribbon.slug}`);
  const ribbonOutput = fs.readFileSync(stagedExecutable);
  const ribbonPatch = verifyRibbonBitmaps(fm, ribbonOutput, bitmapRecords, ribbon.bitmaps, manifest.resourceLanguage);
  const repeatExecutable = path.join(nativeRoot, 'repeat.exe');
  fs.copyFileSync(path.join(source, '7zFM.exe'), repeatExecutable);
  applyNativeUpdate(repeatExecutable, updateManifest, `${arch}/${ribbon.slug} reproducibility check`);
  const repeatOutput = fs.readFileSync(repeatExecutable);
  verifyRibbonBitmaps(fm, repeatOutput, bitmapRecords, ribbon.bitmaps, manifest.resourceLanguage);
  if (!ribbonOutput.equals(repeatOutput)) throw new Error(`${arch}/${ribbon.slug}: identical native resource updates produced different executable bytes`);
  if (ribbonPatch.machine !== expectedMachines[arch]) throw new Error(`${arch}/${ribbon.slug}: wrong PE machine`);
  const unexpected = ribbonPatch.changes.filter((item) => item.classification !== 'expected');
  if (unexpected.length) throw new Error(`${arch}/${ribbon.slug}: unexpected resource changes: ${JSON.stringify(unexpected)}`);
  const stage = path.join(buildRoot, 'packages', arch, ribbon.slug); fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, '7zFM.exe'), ribbonPatch.output);
  fs.copyFileSync(path.join(source, 'License.txt'), path.join(stage, '7-Zip-License.txt'));
  report.results.push({ upstreamVersion: lock.version, releaseId: lock.releaseId, architecture: arch, theme: ribbon.name, inputSha256: sha256(fm), outputSha256: sha256(ribbonPatch.output), changes: ribbonPatch.changes, reproducibility: { method: 'two independent native resource transactions from the same pinned input', byteIdentical: true }, peValidation: validatePe(ribbonPatch.output, expectedMachines[arch], lock.version), functionalTests: { status: 'gui-smoke-pending' } });
  report.artifacts.push(await packageFolder(stage, `${ribbon.slug}-${arch}.7z`, outRoot, source, arch, ribbon.slug));
}
if (!optionsMenuCommand) throw new Error('Could not identify the pinned 7zFM.exe Tools > Options menu command.');
fs.writeFileSync(path.join(buildRoot, 'gui-options-command.json'), `${JSON.stringify(optionsMenuCommand, null, 2)}\n`);
fs.mkdirSync(path.join(root, 'reports/generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'reports/generated/resource-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'reports/generated/build-provenance.json'), `${JSON.stringify({ upstream: lock, tag, node: process.version, sourceCommit: process.env.GITHUB_SHA || null, artifacts: report.artifacts }, null, 2)}\n`);
console.log(`Built ${report.artifacts.length} archives for ${tag}`);

async function packageFolder(folder, name, outputDirectory, upstream, arch, theme) {
  const executable = path.join(upstream, '7z.exe');
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
