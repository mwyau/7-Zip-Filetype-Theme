import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, validatePe, sha256 } from './core.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = readJson(path.join(root, 'config/7zip.lock.json'));
const manifest = readJson(path.join(root, 'config/themes.json'));
const report = readJson(path.join(root, 'reports/generated/resource-diff.json'));
if (report.upstreamVersion !== lock.version || report.results.length !== 8 || report.artifacts.length !== 8) throw new Error('Release report is incomplete or does not match the locked release');
if (report.results.some((result) => result.changes.some((change) => change.classification !== 'expected'))) throw new Error('Resource report contains unexpected changes');
for (const result of report.results) {
  if (result.peValidation.machine !== (result.architecture === 'x86' ? '0x014c' : '0x8664')) throw new Error(`PE architecture mismatch in report: ${result.architecture}/${result.theme}`);
  if (result.changes.length === 0) throw new Error(`No resource changes reported for ${result.architecture}/${result.theme}`);
}
for (const arch of Object.keys(lock.assets)) {
  for (const theme of [...manifest.filetypes, manifest.ribbon]) {
    const slug = theme.slug, packagePath = path.join(root, 'dist', `${slug}-${arch}.7z`);
    if (!fs.existsSync(packagePath)) throw new Error(`Missing package ${slug}-${arch}`);
    const binary = path.join(root, '.build/packages', arch, slug, slug === manifest.ribbon.slug ? '7zFM.exe' : '7z.dll');
    validatePe(fs.readFileSync(binary), arch === 'x86' ? 0x014c : 0x8664, lock.version);
  }
}
for (const name of ['windows10-icons.png', 'fluent-icons.png', 'fluent-blue-icons.png', 'windows11-ribbon.png', 'resource-diff.json', 'summary.md', 'build-provenance.json']) if (!fs.existsSync(path.join(root, 'reports/generated', name))) throw new Error(`Missing generated report ${name}`);
const provenanceSource = path.join(root, 'reports/generated/build-provenance.json');
const provenanceTarget = path.join(root, 'dist/build-provenance.json');
fs.copyFileSync(provenanceSource, provenanceTarget);
const sums = [...report.artifacts.map((item) => `${item.sha256}  ${item.file}`), `${sha256(fs.readFileSync(provenanceTarget))}  build-provenance.json`].join('\n') + '\n';
fs.writeFileSync(path.join(root, 'dist/SHA256SUMS.txt'), sums);
if (process.platform === 'win32') {
  const test = spawnSync(process.execPath, [path.join(root, 'scripts/integration.mjs')], { stdio: 'inherit', cwd: root, windowsHide: true });
  if (test.status !== 0) process.exit(test.status ?? 1);
} else console.log('Windows integration tests not run on this host; GitHub Windows CI is required for release eligibility.');
console.log(`Verified ${report.artifacts.length} theme packages across x86/x64.`);
