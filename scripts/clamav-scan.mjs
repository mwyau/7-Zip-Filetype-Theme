import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const maximumSignatureAgeHours = 48;
const hasWarnings = (output) => /(?:^|[\r\n])\s*(?:WARNING|ERROR):|(?:^|[\r\n])\s*Warnings:\s*[1-9]\d*/i.test(output);
const isRateLimited = (output) => /\b(?:429|too many requests|rate[- ]limit(?:ed|ing)?|throttl(?:e|ed|ing))\b/i.test(output);

export function runCommand(command, args, options = {}) {
  const process = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return {
    status: process.status ?? 2,
    stdout: String(process.stdout ?? ''),
    stderr: String(process.stderr ?? ''),
    error: process.error?.message ?? null,
  };
}

function mustRun(runner, command, args, label, options) {
  const result = runner(command, args, options);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}): ${result.error || result.stderr || result.stdout}`);
  }
  if (hasWarnings(output)) throw new Error(`${label} reported a warning: ${output.trim()}`);
  return result;
}

function listFiles(base) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(base, entry.name);
    return entry.isDirectory() ? listFiles(file) : entry.isFile() ? [file] : [];
  });
}

function expectedMatrix(manifest, lock) {
  const perArchitecture = [
    ...manifest.filetypes.map((theme) => ({ slug: theme.slug, binary: '7z.dll' })),
    { slug: manifest.ribbon.slug, binary: '7zFM.exe' },
  ];
  return Object.fromEntries(Object.keys(lock.assets).map((architecture) => [architecture, perArchitecture]));
}

function archiveListing(output, archive) {
  const separator = output.split(/\r?\n/).findIndex((line) => /^[-]{5,}$/.test(line.trim()));
  if (separator < 0) throw new Error(`7-Zip listing is incomplete for ${path.basename(archive)}`);
  const entries = output.split(/\r?\n/).slice(separator + 1)
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice(7))
    .filter(Boolean)
    .sort();
  return entries;
}

function parseDatabaseInfo(output) {
  const buildText = output.match(/^Build time:\s*(.+)$/mi)?.[1]?.trim();
  const version = output.match(/^Version:\s*(\d+)$/mi)?.[1];
  const buildTime = buildText ? Date.parse(buildText) : NaN;
  if (!Number.isFinite(buildTime) || !version || !/Verification OK/i.test(output)) {
    throw new Error(`Invalid or unverified ClamAV database metadata: ${output.slice(0, 240)}`);
  }
  return {
    version: Number(version),
    buildTime: new Date(buildTime).toISOString(),
    signatures: Number(output.match(/^Signatures:\s*(\d+)$/mi)?.[1] ?? 0),
  };
}

function signatureDatabases(databaseDirectory, certificatesDirectory, sigtool, runner) {
  const databases = {};
  for (const name of ['main', 'daily', 'bytecode']) {
    const file = ['cvd', 'cld'].map((extension) => path.join(databaseDirectory, `${name}.${extension}`))
      .find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error(`Missing required ClamAV ${name} signature database`);
    const info = mustRun(runner, sigtool, [`--cvdcertsdir=${certificatesDirectory}`, `--info=${file}`], `Verifying ${name} signatures`);
    databases[name] = { file: path.basename(file), ...parseDatabaseInfo(`${info.stdout}\n${info.stderr}`) };
  }
  return databases;
}

function assertFresh(databases, now) {
  const cutoff = now - maximumSignatureAgeHours * 60 * 60 * 1000;
  for (const [name, database] of Object.entries(databases)) {
    const built = Date.parse(database.buildTime);
    if (name === 'daily' && built < cutoff) {
      throw new Error(`daily signature database is stale (built ${database.buildTime}; max age ${maximumSignatureAgeHours} hours)`);
    }
    if (built > now + 15 * 60 * 1000) throw new Error(`${name} signature database build time is in the future (${database.buildTime})`);
  }
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.files.map((item) => `| ${item.name.replaceAll('|', '\\|')} | ${item.sha256} | ${item.kind} |`).join('\n');
  const databases = Object.entries(report.databases).map(([name, database]) =>
    `| ${name} | ${database.version} | ${database.buildTime} | ${database.signatures} |`).join('\n');
  const markdown = [
    '# ClamAV scan report',
    '',
    `- Verdict: **${report.verdict}**`,
    `- Engine: ${report.engineVersion ?? 'unavailable'}`,
    `- Signature update: ${report.signatureUpdate?.status ?? 'failed'}`,
    `- Signature update completed: ${report.signatureUpdate?.completedAt ?? 'unavailable'}`,
    `- File count: ${report.fileCount}`,
    `- Scanned files: ${report.scanSummary?.scannedFiles ?? 'unavailable'}`,
    `- Infected files: ${report.scanSummary?.infectedFiles ?? 'unavailable'}`,
    `- Error: ${report.error ?? 'none'}`,
    '',
    '## Signature databases',
    '',
    '| Database | Version | Build time (UTC) | Signatures |',
    '|---|---:|---|---:|',
    databases || '| unavailable | — | — | — |',
    '',
    '## Scanned files',
    '',
    '| File | SHA-256 | Kind |',
    '|---|---|---|',
    rows || '| none | — | — |',
    '',
  ].join('\n');
  fs.writeFileSync(file.replace(/\.json$/i, '.md'), markdown);
}

function scannerVersion(output) {
  const version = output.match(/ClamAV\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!version) throw new Error(`Unexpected ClamAV version output: ${output.trim()}`);
  const [major, minor, patch] = version.slice(1).map(Number);
  if (major < 1 || (major === 1 && minor < 5)) throw new Error(`ClamAV 1.5.0 or newer is required (found ${output.trim()})`);
  return output.trim().split(/[\r\n]/)[0];
}

function writeFreshclamConfig(file, databaseDirectory, certificatesDirectory) {
  const quote = (value) => `"${path.resolve(value)}"`;
  const contents = [
    `DatabaseDirectory ${quote(databaseDirectory)}`,
    `CVDCertsDirectory ${quote(certificatesDirectory)}`,
    'DatabaseMirror database.clamav.net',
    'MaxAttempts 3',
  ].join('\r\n') + '\r\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'ascii');
}

/** Run the Windows portable ClamAV gate against the exact built package set. */
export function scanArtifacts({
  rootDir,
  reportFile,
  clamavDirectory,
  databaseDirectory,
  sevenZipPath,
  repository = repositoryRoot,
  runner = runCommand,
  now = Date.now(),
}) {
  const report = {
    generatedAt: new Date(now).toISOString(),
    engineVersion: null,
    signatureUpdate: null,
    databases: {},
    fileCount: 0,
    scanExitCode: null,
    scanSummary: null,
    verdict: 'FAILED',
    error: null,
    files: [],
  };
  let temporaryDirectory = null;

  try {
    const clamScan = path.join(clamavDirectory, 'clamscan.exe');
    const freshClam = path.join(clamavDirectory, 'freshclam.exe');
    const sigtool = path.join(clamavDirectory, 'sigtool.exe');
    const certificatesDirectory = path.join(clamavDirectory, 'certs');
    for (const tool of [clamScan, freshClam, sigtool, sevenZipPath]) {
      if (!fs.existsSync(tool)) throw new Error(`Required scanner tool is missing: ${tool}`);
    }
    if (!fs.existsSync(certificatesDirectory)) throw new Error(`ClamAV certificate directory is missing: ${certificatesDirectory}`);

    const manifest = readJson(path.join(repository, 'config/themes.json'));
    const lock = readJson(path.join(repository, 'config/7zip.lock.json'));
    const expected = expectedMatrix(manifest, lock);
    const binaryRoot = path.join(rootDir, 'packages');
    const archiveRoot = path.join(rootDir, 'dist');
    const expectedBinaries = [];
    const expectedArchives = [];
    for (const [architecture, themes] of Object.entries(expected)) {
      for (const theme of themes) {
        expectedBinaries.push(path.posix.join(architecture, theme.slug, theme.binary));
        expectedArchives.push(`${theme.slug}-${architecture}.7z`);
      }
    }
    expectedBinaries.sort();
    expectedArchives.sort();

    const expectedPackageFiles = [
      ...expectedBinaries,
      ...expectedBinaries.map((relative) => {
        const [architecture, slug] = relative.split('/');
        return path.posix.join(architecture, slug, '7-Zip-License.txt');
      }),
    ].sort();
    const actualPackageFiles = listFiles(binaryRoot)
      .map((file) => path.relative(binaryRoot, file).split(path.sep).join('/'))
      .sort();
    if (JSON.stringify(actualPackageFiles) !== JSON.stringify(expectedPackageFiles)) {
      throw new Error('Generated package inventory incomplete or unexpected. Expected ' + expectedPackageFiles.join(', ') + '; found ' + (actualPackageFiles.join(', ') || '(none)'));
    }
    const actualArchives = fs.existsSync(archiveRoot)
      ? fs.readdirSync(archiveRoot).filter((name) => name.toLowerCase().endsWith('.7z')).sort()
      : [];
    if (JSON.stringify(actualArchives) !== JSON.stringify(expectedArchives)) {
      throw new Error(`Release archive set incomplete or unexpected. Expected ${expectedArchives.join(', ')}; found ${actualArchives.join(', ') || '(none)'}`);
    }

    const version = mustRun(runner, clamScan, ['--version'], 'ClamAV version');
    report.engineVersion = scannerVersion(`${version.stdout}\n${version.stderr}`);

    fs.mkdirSync(databaseDirectory, { recursive: true });
    const configurationFile = path.join(path.dirname(databaseDirectory), 'freshclam.conf');
    writeFreshclamConfig(configurationFile, databaseDirectory, certificatesDirectory);
    const update = runner(freshClam, [
      `--config-file=${configurationFile}`,
      `--datadir=${databaseDirectory}`,
      `--cvdcertsdir=${certificatesDirectory}`,
      '--stdout',
    ], { timeoutMs: 10 * 60 * 1000 });
    const updateOutput = `${update.stdout}\n${update.stderr}`.trim();
    const rateLimited = isRateLimited(updateOutput);
    report.signatureUpdate = {
      status: 'updated-or-current',
      completedAt: new Date().toISOString(),
      exitCode: update.status,
    };
    if (rateLimited || update.error || update.status !== 0 || hasWarnings(updateOutput)) {
      report.signatureUpdate.status = rateLimited ? 'rate-limited' : 'failed';
      report.signatureUpdate.message = rateLimited
        ? 'ClamAV CDN rate-limited FreshClam; no scan was attempted. Retry after the CDN cooldown.'
        : 'FreshClam failed or reported a warning; no scan was attempted.';
      report.signatureUpdate.details = (update.error || updateOutput).slice(-4000);
      throw new Error(`${report.signatureUpdate.message} ${update.error || updateOutput}`.trim());
    }

    report.databases = signatureDatabases(databaseDirectory, certificatesDirectory, sigtool, runner);
    assertFresh(report.databases, now);

    const scanInputs = [];
    for (const relative of expectedBinaries) {
      const file = path.join(binaryRoot, ...relative.split('/'));
      report.files.push({
        name: path.posix.join('packages', relative),
        kind: 'generated-binary',
        sha256: hashFile(file),
      });
      scanInputs.push(file);
    }

    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'clamav-theme-scan-'));
    for (const archiveName of expectedArchives) {
      const match = archiveName.match(/^(.+)-(x86|x64)\.7z$/);
      if (!match) throw new Error(`Unexpected release archive name: ${archiveName}`);
      const [, slug, architecture] = match;
      const theme = [...manifest.filetypes, manifest.ribbon].find((item) => item.slug === slug);
      if (!theme) throw new Error(`No theme is mapped for release archive ${archiveName}`);
      const binary = theme.slug === manifest.ribbon.slug ? '7zFM.exe' : '7z.dll';
      const archive = path.join(archiveRoot, archiveName);
      const expectedEntries = [binary, '7-Zip-License.txt'].sort();
      const listing = mustRun(runner, sevenZipPath, ['l', '-slt', archive], `Listing ${archiveName}`);
      const entries = archiveListing(listing.stdout, archive);
      if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
        throw new Error(`${archiveName}: unexpected or incomplete packaged files: ${entries.join(', ')}`);
      }

      const extractedDirectory = path.join(temporaryDirectory, `${slug}-${architecture}`);
      fs.mkdirSync(extractedDirectory, { recursive: true });
      mustRun(runner, sevenZipPath, ['x', '-y', `-o${extractedDirectory}`, archive], `Extracting ${archiveName}`);
      const extractedFiles = listFiles(extractedDirectory)
        .map((file) => path.relative(extractedDirectory, file).split(path.sep).join('/'))
        .sort();
      if (JSON.stringify(extractedFiles) !== JSON.stringify(expectedEntries)) {
        throw new Error(`${archiveName}: extraction did not produce the expected package contents: ${extractedFiles.join(', ')}`);
      }
      const rawBinary = path.join(binaryRoot, architecture, slug, binary);
      const extractedBinary = path.join(extractedDirectory, binary);
      if (hashFile(extractedBinary) !== hashFile(rawBinary)) {
        throw new Error(`${archiveName}: packaged ${binary} differs from its generated build output`);
      }
      report.files.push({
        name: path.posix.join('dist', archiveName),
        kind: 'release-archive',
        sha256: hashFile(archive),
      });
      scanInputs.push(archive);
    }

    report.fileCount = report.files.length;
    if (report.fileCount !== expectedBinaries.length + expectedArchives.length) {
      throw new Error(`Incomplete scan set (${report.fileCount} files recorded)`);
    }
    const scan = runner(clamScan, [
      `--database=${databaseDirectory}`,
      `--cvdcertsdir=${certificatesDirectory}`,
      '--scan-archive=yes',
      '--alert-exceeds-max=yes',
      '--alert-broken=yes',
      '--verbose',
      ...scanInputs,
    ], { timeoutMs: 20 * 60 * 1000 });
    report.scanExitCode = scan.status;
    const scanOutput = `${scan.stdout}\n${scan.stderr}`.trim();
    const scanned = scanOutput.match(/^Scanned files:\s*(\d+)$/mi);
    const infected = scanOutput.match(/^Infected files:\s*(\d+)$/mi);
    if (scanned && infected) {
      report.scanSummary = { scannedFiles: Number(scanned[1]), infectedFiles: Number(infected[1]) };
    }
    if (scan.error || (scan.status !== 0 && scan.status !== 1)) {
      throw new Error(`ClamAV scanner failed (exit ${scan.status}): ${scan.error || scan.stderr || scan.stdout}`);
    }
    if (scan.status === 1 || /\bFOUND\b/i.test(scanOutput) || (infected && Number(infected[1]) !== 0)) {
      throw new Error(`ClamAV detected malware: ${scanOutput.match(/^.*\bFOUND\b.*$/mi)?.[0] ?? 'infected file reported'}`);
    }
    if (!scanned || !infected || Number(scanned[1]) < scanInputs.length) {
      throw new Error(`ClamAV scan appears incomplete (${scanned?.[1] ?? 'no count'} of ${scanInputs.length} inputs reported scanned)`);
    }
    if (hasWarnings(scanOutput)) throw new Error(`ClamAV reported an incomplete or warning result: ${scanOutput}`);
    report.verdict = 'CLEAN';
  } catch (error) {
    report.error = error.message;
  } finally {
    report.fileCount = report.files.length;
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    writeReport(reportFile, report);
  }

  if (report.verdict !== 'CLEAN') {
    const error = new Error(report.error || 'ClamAV scan failed');
    error.report = report;
    throw error;
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
  };
  const reportFile = path.resolve(argument('--report', 'clamav-report/report.json'));
  try {
    const clamavDirectory = argument('--clamav-dir', process.env.CLAMAV_DIRECTORY);
    if (!clamavDirectory) throw new Error('Pass --clamav-dir with the verified portable ClamAV directory.');
    const report = scanArtifacts({
      rootDir: path.resolve(argument('--root', 'scan-input')),
      reportFile,
      clamavDirectory: path.resolve(clamavDirectory),
      databaseDirectory: path.resolve(argument('--database-dir', '.build/clamav/database')),
      sevenZipPath: path.resolve(argument('--sevenzip', 'scan-input/tools/7zr.exe')),
    });
    console.log(`ClamAV verdict: ${report.verdict}; ${report.fileCount} binaries and archives scanned with ${report.engineVersion}.`);
  } catch (error) {
    console.error(`ClamAV gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
