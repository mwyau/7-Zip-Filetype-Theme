import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanArtifacts } from '../scripts/clamav-scan.mjs';
import { verifyScannedArtifact } from '../scripts/verify-clamav-artifact.mjs';
import { readJson } from '../scripts/core.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixedNow = Date.parse('2026-10-11T18:00:00Z');
const manifest = readJson(path.join(repository, 'config/themes.json'));
const lock = readJson(path.join(repository, 'config/7zip.lock.json'));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clamav-fixture-'));
  const packages = path.join(root, 'input/packages'), dist = path.join(root, 'input/dist'), db = path.join(root, 'db');
  fs.mkdirSync(db, { recursive: true });
  for (const name of ['main.cvd', 'daily.cvd', 'bytecode.cvd']) fs.writeFileSync(path.join(db, name), 'mock signature database');
  const items = [...manifest.filetypes.map((theme) => ({ slug: theme.slug, binary: '7z.dll' })), { slug: manifest.ribbon.slug, binary: '7zFM.exe' }];
  for (const arch of Object.keys(lock.assets)) for (const item of items) {
    const dir = path.join(packages, arch, item.slug); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, item.binary), `controlled clean fixture: ${arch}/${item.slug}/${item.binary}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, `${item.slug}-${arch}.7z`), `mock archive: ${arch}/${item.slug}`);
  }
  return { root, input: path.join(root, 'input'), db, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function mockRunner({ updateStatus = 0, scannerStatus = 0, scannerOutput = null, serviceActive = false, dbTime = fixedNow } = {}) {
  return (command, args) => {
    if (command === 'systemctl' && args[0] === 'is-active') return { status: serviceActive ? 0 : 3, stdout: '', stderr: '' };
    if (command === 'sudo' && args[0] === 'systemctl') { serviceActive = false; return { status: 0, stdout: '', stderr: '' }; }
    if (command === 'sudo' && args[0] === 'freshclam') return { status: updateStatus, stdout: 'freshclam updated/current databases', stderr: '' };
    if (command === 'clamscan' && args[0] === '--version') return { status: 0, stdout: 'ClamAV 1.4.3/123/2026\n', stderr: '' };
    if (command === 'sigtool') return { status: 0, stdout: `File: ${path.basename(args.at(-1))}\nBuild time: ${new Date(dbTime).toUTCString()}\nVersion: 42\nSignatures: 987654\nVerification OK.\n`, stderr: '' };
    if (command === '7z' && args[0] === 'l') {
      const archive = args.at(-1), name = path.basename(archive), [arch, ...slugParts] = name.slice(0, -3).split('-').reverse();
      const slug = slugParts.reverse().join('-'); const theme = [...manifest.filetypes, manifest.ribbon].find((item) => item.slug === slug);
      const binary = theme.slug === manifest.ribbon.slug ? '7zFM.exe' : '7z.dll';
      return { status: 0, stdout: `Path = ${name}\nType = 7z\n\n----------\nPath = ${binary}\nPath = 7-Zip-License.txt\n`, stderr: '' };
    }
    if (command === '7z' && args[0] === 'x') {
      const dest = args.find((arg) => arg.startsWith('-o')).slice(2), name = path.basename(args.at(-1)), [arch, ...slugParts] = name.slice(0, -3).split('-').reverse();
      const slug = slugParts.reverse().join('-'), theme = [...manifest.filetypes, manifest.ribbon].find((item) => item.slug === slug);
      const binary = theme.slug === manifest.ribbon.slug ? '7zFM.exe' : '7z.dll';
      fs.mkdirSync(dest, { recursive: true });
      // Copy the corresponding raw fixture binary from the supplied test input root.
      const raw = path.join(globalThis.__clamavFixtureInput, 'packages', arch, slug, binary);
      fs.copyFileSync(raw, path.join(dest, binary)); fs.writeFileSync(path.join(dest, '7-Zip-License.txt'), 'license');
      return { status: 0, stdout: 'Everything is Ok', stderr: '' };
    }
    if (command === 'clamscan') return { status: scannerStatus, stdout: scannerOutput ?? `----------- SCAN SUMMARY -----------\nScanned files: ${args.length - 6}\nInfected files: ${scannerStatus === 1 ? 1 : 0}\n${scannerStatus === 1 ? 'Simulated.Threat FOUND' : ''}`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}
function runFixture(options = {}) {
  const f = fixture(); globalThis.__clamavFixtureInput = f.input;
  const reportFile = path.join(f.root, 'report/report.json');
  try {
    const report = scanArtifacts({ rootDir: f.input, reportFile, repository, dbDir: f.db, now: fixedNow, runner: mockRunner(options) });
    return { f, report, reportFile };
  } catch (error) { return { f, error, report: JSON.parse(fs.readFileSync(reportFile, 'utf8')), reportFile }; }
  finally { delete globalThis.__clamavFixtureInput; }
}
test('ClamAV gate accepts the complete clean matrix and reports all raw/archive/extracted hashes', () => {
  const { f, report } = runFixture({ serviceActive: true });
  try {
    assert.equal(report.verdict, 'CLEAN'); assert.equal(report.fileCount, 24); assert.equal(report.scanSummary.scannedFiles, 24);
    assert.equal(report.databases.daily.version, 42); assert.equal(report.signatureUpdate.status, 'updated-or-current');
    assert.equal(report.files.filter((item) => item.kind === 'generated-binary').length, 8);
    assert.equal(report.files.filter((item) => item.kind === 'release-archive').length, 8);
    assert.equal(report.files.filter((item) => item.kind === 'archive-binary').length, 8);
    const downloaded = path.join(f.root, 'download'); fs.cpSync(f.input, downloaded, { recursive: true });
    assert.equal(verifyScannedArtifact(downloaded, report).verifiedFiles, 16);
  } finally { f.cleanup(); }
});
test('ClamAV gate fails closed when generated binaries are missing', () => {
  const f = fixture(); globalThis.__clamavFixtureInput = f.input;
  fs.unlinkSync(path.join(f.input, 'packages/x86/windows10/7z.dll'));
  const reportFile = path.join(f.root, 'report/report.json');
  try { assert.throws(() => scanArtifacts({ rootDir: f.input, reportFile, repository, dbDir: f.db, now: fixedNow, runner: mockRunner() }), /binary set incomplete/); assert.equal(JSON.parse(fs.readFileSync(reportFile)).verdict, 'FAILED'); }
  finally { delete globalThis.__clamavFixtureInput; f.cleanup(); }
});
test('ClamAV gate rejects failed freshclam updates and missing signature databases', () => {
  const failedUpdate = runFixture({ updateStatus: 2 });
  try { assert.match(failedUpdate.error.message, /freshclam failed/); assert.equal(failedUpdate.report.signatureUpdate.exitCode, 2); }
  finally { failedUpdate.f.cleanup(); }
  const missing = fixture(); fs.unlinkSync(path.join(missing.db, 'daily.cvd'));
  try { assert.throws(() => scanArtifacts({ rootDir: missing.input, reportFile: path.join(missing.root, 'r.json'), repository, dbDir: missing.db, now: fixedNow, runner: mockRunner() }), /Missing required ClamAV daily/); }
  finally { missing.cleanup(); }
});
test('ClamAV gate rejects stale signature databases', () => {
  const result = runFixture({ dbTime: fixedNow - 72 * 60 * 60 * 1000 });
  try { assert.match(result.error.message, /signature database is stale/); assert.equal(result.report.verdict, 'FAILED'); }
  finally { result.f.cleanup(); }
});
test('ClamAV malware verdict and scanner errors both fail', () => {
  const infected = runFixture({ scannerStatus: 1, scannerOutput: 'Simulated.Threat FOUND\nScanned files: 24\nInfected files: 1' });
  try { assert.match(infected.error.message, /detected a threat/); assert.equal(infected.report.scanExitCode, 1); }
  finally { infected.f.cleanup(); }
  const broken = runFixture({ scannerStatus: 2, scannerOutput: 'ERROR: scanner failed' });
  try { assert.match(broken.error.message, /scanner error/); assert.equal(broken.report.scanExitCode, 2); }
  finally { broken.f.cleanup(); }
});
test('ClamAV gate rejects incomplete/limited scan warnings even with exit zero', () => {
  const result = runFixture({ scannerStatus: 0, scannerOutput: 'WARNING: archive scan exceeded size limit\nScanned files: 24\nInfected files: 0' });
  try { assert.match(result.error.message, /warning or incomplete scan/); assert.equal(result.report.verdict, 'FAILED'); }
  finally { result.f.cleanup(); }
});
test('post-download verification rejects changed or missing scanned artifacts', () => {
  const { f, report } = runFixture();
  try {
    const downloaded = path.join(f.root, 'download'); fs.cpSync(f.input, downloaded, { recursive: true });
    fs.appendFileSync(path.join(downloaded, 'packages/x64/fluent/7z.dll'), 'changed');
    assert.throws(() => verifyScannedArtifact(downloaded, report), /checksum mismatch/);
    fs.copyFileSync(path.join(f.input, 'packages/x64/fluent/7z.dll'), path.join(downloaded, 'packages/x64/fluent/7z.dll'));
    fs.appendFileSync(path.join(downloaded, 'dist/windows10-x86.7z'), 'changed');
    assert.throws(() => verifyScannedArtifact(downloaded, report), /checksum mismatch/);
    fs.copyFileSync(path.join(f.input, 'dist/windows10-x86.7z'), path.join(downloaded, 'dist/windows10-x86.7z'));
    fs.rmSync(path.join(downloaded, 'dist/windows10-x86.7z'));
    assert.throws(() => verifyScannedArtifact(downloaded, report), /missing after download|output set differs/);
  } finally { f.cleanup(); }
});
