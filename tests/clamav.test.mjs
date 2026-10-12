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
const themeItems = [
  ...manifest.filetypes.map((theme) => ({ slug: theme.slug, binary: '7z.dll' })),
  { slug: manifest.ribbon.slug, binary: '7zFM.exe' },
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clamav-fixture-'));
  const input = path.join(root, 'input');
  const tools = path.join(root, 'tools', 'clamav');
  const sevenZip = path.join(root, 'tools', '7zr.exe');
  const databases = path.join(root, 'database');
  fs.mkdirSync(path.join(input, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(tools, 'certs'), { recursive: true });
  for (const name of ['clamscan.exe', 'freshclam.exe', 'sigtool.exe']) fs.writeFileSync(path.join(tools, name), 'mock tool');
  fs.writeFileSync(path.join(tools, 'certs', 'clamav.crt'), 'mock certificate');
  fs.writeFileSync(sevenZip, 'mock extractor');
  for (const architecture of Object.keys(lock.assets)) {
    for (const item of themeItems) {
      const directory = path.join(input, 'packages', architecture, item.slug);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, item.binary), 'fixture ' + architecture + '/' + item.slug + '/' + item.binary);
      fs.writeFileSync(path.join(directory, '7-Zip-License.txt'), 'fixture license');
      fs.writeFileSync(path.join(input, 'dist', item.slug + '-' + architecture + '.7z'), 'fixture archive');
    }
  }
  return {
    root,
    input,
    tools,
    databases,
    sevenZip,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function archiveParts(file) {
  const match = path.basename(file).match(/^(.+)-(x86|x64)\.7z$/);
  if (!match) throw new Error('Unexpected fixture archive name: ' + file);
  return { slug: match[1], architecture: match[2] };
}

function mockRunner(options = {}, input) {
  return (command, args) => {
    const name = path.basename(command).toLowerCase();
    if (name === 'clamscan.exe' && args[0] === '--version') {
      return { status: 0, stdout: options.engineVersion || 'ClamAV 1.5.4\n', stderr: '' };
    }
    if (name === 'freshclam.exe') {
      if (options.updateStatus !== undefined || options.updateOutput) {
        return {
          status: options.updateStatus ?? 0,
          stdout: options.updateOutput || '',
          stderr: '',
        };
      }
      const databaseArgument = args.find((argument) => argument.startsWith('--datadir='));
      const databaseDirectory = databaseArgument.slice('--datadir='.length);
      if (!options.missingSignature) {
        fs.mkdirSync(databaseDirectory, { recursive: true });
        for (const database of ['main', 'daily', 'bytecode']) {
          fs.writeFileSync(path.join(databaseDirectory, database + '.cvd'), 'fixture signature');
        }
      } else {
        fs.mkdirSync(databaseDirectory, { recursive: true });
        for (const database of ['main', 'daily', 'bytecode']) {
          if (database !== options.missingSignature) fs.writeFileSync(path.join(databaseDirectory, database + '.cvd'), 'fixture signature');
        }
      }
      return { status: 0, stdout: 'Database update complete\n', stderr: '' };
    }
    if (name === 'sigtool.exe') {
      const info = args.find((argument) => argument.startsWith('--info='));
      const buildTime = new Date(options.dbTime ?? fixedNow).toUTCString();
      const verification = options.invalidSignature ? 'Verification FAILED.' : 'Verification OK.';
      return {
        status: 0,
        stdout: 'File: ' + path.basename(info.slice('--info='.length)) + '\nBuild time: ' + buildTime + '\nVersion: 63\nSignatures: 987654\n' + verification + '\n',
        stderr: '',
      };
    }
    if (name === '7zr.exe' && args[0] === 'l') {
      const parts = archiveParts(args.at(-1));
      const item = themeItems.find((theme) => theme.slug === parts.slug);
      return {
        status: 0,
        stdout: 'Path = ' + path.basename(args.at(-1)) + '\nType = 7z\n\n----------\nPath = ' + item.binary + '\nPath = 7-Zip-License.txt\n',
        stderr: '',
      };
    }
    if (name === '7zr.exe' && args[0] === 'x') {
      const destination = args.find((argument) => argument.startsWith('-o')).slice(2);
      const archive = args.at(-1);
      const parts = archiveParts(archive);
      const item = themeItems.find((theme) => theme.slug === parts.slug);
      const raw = path.join(input, 'packages', parts.architecture, parts.slug, item.binary);
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(raw, path.join(destination, item.binary));
      fs.writeFileSync(path.join(destination, '7-Zip-License.txt'), 'fixture license');
      if (options.archiveHashMismatch && parts.slug === 'windows10' && parts.architecture === 'x86') {
        fs.appendFileSync(path.join(destination, item.binary), 'changed');
      }
      return { status: 0, stdout: 'Everything is Ok\n', stderr: '' };
    }
    if (name === 'clamscan.exe') {
      if (options.scanOutput) return { status: options.scanStatus ?? 0, stdout: options.scanOutput, stderr: '' };
      const infected = Boolean(options.infected);
      return {
        status: options.scanStatus ?? (infected ? 1 : 0),
        stdout: '----------- SCAN SUMMARY -----------\nScanned files: ' + (options.scannedFiles ?? 16) +
          '\nInfected files: ' + (infected ? 1 : 0) + (infected ? '\nFixture.Threat FOUND\n' : '\n'),
        stderr: '',
      };
    }
    throw new Error('Unexpected scanner command: ' + command + ' ' + args.join(' '));
  };
}

function runFixture(options = {}) {
  const f = fixture();
  const reportFile = path.join(f.root, 'report', 'report.json');
  try {
    const report = scanArtifacts({
      rootDir: f.input,
      reportFile,
      clamavDirectory: f.tools,
      databaseDirectory: f.databases,
      sevenZipPath: f.sevenZip,
      repository,
      now: fixedNow,
      runner: mockRunner(options, f.input),
    });
    return { f, report, reportFile };
  } catch (error) {
    return {
      f,
      error,
      report: JSON.parse(fs.readFileSync(reportFile, 'utf8')),
      reportFile,
    };
  }
}

test('Windows ClamAV gate scans the complete clean binary and archive matrix', () => {
  const { f, report } = runFixture();
  try {
    assert.equal(report.verdict, 'CLEAN');
    assert.equal(report.fileCount, 16);
    assert.equal(report.scanSummary.scannedFiles, 16);
    assert.equal(report.databases.daily.version, 63);
    assert.equal(report.signatureUpdate.status, 'updated-or-current');
    assert.equal(report.files.filter((item) => item.kind === 'generated-binary').length, 8);
    assert.equal(report.files.filter((item) => item.kind === 'release-archive').length, 8);

    const downloaded = path.join(f.root, 'download');
    fs.cpSync(f.input, downloaded, { recursive: true });
    assert.equal(verifyScannedArtifact(downloaded, report).verifiedFiles, 16);
  } finally {
    f.cleanup();
  }
});

test('Windows ClamAV gate rejects missing or unexpected build artifacts', () => {
  const f = fixture();
  const reportFile = path.join(f.root, 'report', 'report.json');
  fs.unlinkSync(path.join(f.input, 'packages', 'x86', 'windows10', '7z.dll'));
  try {
    assert.throws(() => scanArtifacts({
      rootDir: f.input,
      reportFile,
      clamavDirectory: f.tools,
      databaseDirectory: f.databases,
      sevenZipPath: f.sevenZip,
      repository,
      now: fixedNow,
      runner: mockRunner({}, f.input),
    }), /package inventory incomplete/);
    assert.equal(JSON.parse(fs.readFileSync(reportFile, 'utf8')).verdict, 'FAILED');
  } finally {
    f.cleanup();
  }

  const extra = fixture();
  fs.writeFileSync(path.join(extra.input, 'packages', 'x64', 'fluent', 'unexpected.exe'), 'extra');
  try {
    assert.throws(() => scanArtifacts({
      rootDir: extra.input,
      reportFile: path.join(extra.root, 'extra-report.json'),
      clamavDirectory: extra.tools,
      databaseDirectory: extra.databases,
      sevenZipPath: extra.sevenZip,
      repository,
      now: fixedNow,
      runner: mockRunner({}, extra.input),
    }), /package inventory incomplete/);
  } finally {
    extra.cleanup();
  }
});

test('Windows ClamAV gate rejects failed and CDN-throttled signature updates', () => {
  const failed = runFixture({ updateStatus: 2, updateOutput: 'FreshClam failed' });
  try {
    assert.match(failed.error.message, /FreshClam failed/);
    assert.equal(failed.report.signatureUpdate.status, 'failed');
    assert.equal(failed.report.scanExitCode, null);
  } finally {
    failed.f.cleanup();
  }

  const throttled = runFixture({ updateStatus: 1, updateOutput: 'ERROR: 429 Too Many Requests from database.clamav.net' });
  try {
    assert.match(throttled.error.message, /rate-limited.*no scan was attempted/i);
    assert.equal(throttled.report.signatureUpdate.status, 'rate-limited');
    assert.equal(throttled.report.scanExitCode, null);
  } finally {
    throttled.f.cleanup();
  }

  const warningThrottle = runFixture({ updateStatus: 0, updateOutput: 'WARNING: 429 Too Many Requests from database.clamav.net' });
  try {
    assert.match(warningThrottle.error.message, /rate-limited.*no scan was attempted/i);
    assert.equal(warningThrottle.report.signatureUpdate.status, 'rate-limited');
    assert.equal(warningThrottle.report.scanExitCode, null);
  } finally {
    warningThrottle.f.cleanup();
  }
});

test('Windows ClamAV gate requires verified current signatures', () => {
  const missing = runFixture({ missingSignature: 'daily' });
  try {
    assert.match(missing.error.message, /Missing required ClamAV daily/);
  } finally {
    missing.f.cleanup();
  }

  const invalid = runFixture({ invalidSignature: true });
  try {
    assert.match(invalid.error.message, /Invalid or unverified ClamAV database metadata/);
  } finally {
    invalid.f.cleanup();
  }

  const stale = runFixture({ dbTime: fixedNow - 72 * 60 * 60 * 1000 });
  try {
    assert.match(stale.error.message, /daily signature database is stale/);
  } finally {
    stale.f.cleanup();
  }
});

test('Windows ClamAV gate rejects unsupported engine versions', () => {
  const result = runFixture({ engineVersion: 'ClamAV 1.4.6' });
  try {
    assert.match(result.error.message, /ClamAV 1\.5\.0 or newer is required/);
    assert.equal(result.report.verdict, 'FAILED');
  } finally {
    result.f.cleanup();
  }
});

test('Windows ClamAV gate rejects malware and scanner failures', () => {
  const infected = runFixture({ infected: true });
  try {
    assert.match(infected.error.message, /detected malware/);
    assert.equal(infected.report.scanExitCode, 1);
  } finally {
    infected.f.cleanup();
  }

  const failed = runFixture({ scanStatus: 2, scanOutput: 'ERROR: scanner failed' });
  try {
    assert.match(failed.error.message, /scanner failed/);
    assert.equal(failed.report.scanExitCode, 2);
  } finally {
    failed.f.cleanup();
  }

  const incomplete = runFixture({ scannedFiles: 15 });
  try {
    assert.match(incomplete.error.message, /scan appears incomplete/);
  } finally {
    incomplete.f.cleanup();
  }
});

test('Windows ClamAV gate rejects archives whose packaged binary differs from build output', () => {
  const result = runFixture({ archiveHashMismatch: true });
  try {
    assert.match(result.error.message, /packaged 7z\.dll differs from its generated build output/);
    assert.equal(result.report.scanExitCode, null);
  } finally {
    result.f.cleanup();
  }
});

test('release verification rejects changed, missing, or unscanned artifacts', () => {
  const { f, report } = runFixture();
  try {
    const downloaded = path.join(f.root, 'download');
    fs.cpSync(f.input, downloaded, { recursive: true });
    fs.appendFileSync(path.join(downloaded, 'packages', 'x64', 'fluent', '7z.dll'), 'changed');
    assert.throws(() => verifyScannedArtifact(downloaded, report), /checksum mismatch/);
    fs.copyFileSync(
      path.join(f.input, 'packages', 'x64', 'fluent', '7z.dll'),
      path.join(downloaded, 'packages', 'x64', 'fluent', '7z.dll'),
    );
    fs.rmSync(path.join(downloaded, 'dist', 'windows10-x86.7z'));
    assert.throws(() => verifyScannedArtifact(downloaded, report), /missing after download|output set differs/);
  } finally {
    f.cleanup();
  }
});
