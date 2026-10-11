import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result = (status, stdout = '', stderr = '', error = null) => ({ status, stdout: String(stdout), stderr: String(stderr), error });
const hasCommandWarnings = (output) => /(?:^|\n)\s*(?:WARNING|ERROR):|(?:^|\n)\s*Warnings:\s*[1-9]\d*/i.test(output);
export function runCommand(command, args, options = {}) {
  const p = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return result(p.status ?? 2, p.stdout, p.stderr, p.error?.message ?? null);
}
function mustRun(runner, command, args, label, cwd) {
  const p = runner(command, args, { cwd });
  if (p.error || p.status !== 0) throw new Error(`${label} failed (exit ${p.status}): ${p.error || p.stderr || p.stdout}`);
  const output = `${p.stdout}\n${p.stderr}`;
  if (hasCommandWarnings(output)) throw new Error(`${label} reported a warning despite exit zero: ${output}`);
  return p;
}
function listFiles(base) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(base, item.name);
    return item.isDirectory() ? listFiles(file) : item.isFile() ? [file] : [];
  });
}
function expectedMatrix(manifest, lock) {
  const perArch = [...manifest.filetypes.map((theme) => ({ slug: theme.slug, binary: '7z.dll' })), { slug: manifest.ribbon.slug, binary: '7zFM.exe' }];
  return Object.fromEntries(Object.keys(lock.assets).map((arch) => [arch, perArch]));
}
function archiveListing(text, archive) {
  const marker = text.split(/\r?\n/).findIndex((line) => /^[-]{5,}$/.test(line.trim()));
  if (marker < 0) throw new Error(`7z listing is incomplete for ${path.basename(archive)}`);
  return text.split(/\r?\n/).slice(marker + 1).filter((line) => line.startsWith('Path = ')).map((line) => line.slice(7)).filter((name) => name && name !== path.basename(archive)).sort();
}
function parseDatabaseInfo(text) {
  const buildText = text.match(/^Build time:\s*(.+)$/mi)?.[1]?.trim();
  const version = text.match(/^Version:\s*(\d+)$/mi)?.[1];
  const buildTime = buildText ? Date.parse(buildText) : NaN;
  if (!Number.isFinite(buildTime) || !version || !/Verification OK/i.test(text)) throw new Error(`Invalid or unverified ClamAV database metadata: ${text.slice(0, 240)}`);
  return { version: Number(version), buildTime: new Date(buildTime).toISOString(), signatures: Number(text.match(/^Signatures:\s*(\d+)$/mi)?.[1] ?? 0) };
}
function signatureDatabases(dbDir, certsDir, runner) {
  const databases = {};
  for (const base of ['main', 'daily', 'bytecode']) {
    const file = ['cvd', 'cld'].map((ext) => path.join(dbDir, `${base}.${ext}`)).find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error(`Missing required ClamAV ${base} signature database`);
    const info = mustRun(runner, 'sigtool', [`--cvdcertsdir=${certsDir}`, '--info', file], `sigtool ${base}`);
    databases[base] = { file: path.basename(file), ...parseDatabaseInfo(`${info.stdout}\n${info.stderr}`) };
  }
  return databases;
}
function assertFresh(databases, now, maxAgeHours) {
  const cutoff = now - maxAgeHours * 60 * 60 * 1000;
  // The daily database is updated continuously. Main/bytecode databases change only when
  // ClamAV publishes a new set, so they are signature-verified but not age-gated.
  for (const [name, db] of Object.entries(databases)) {
    const built = Date.parse(db.buildTime);
    if (name === 'daily' && built < cutoff) throw new Error(`${name} signature database is stale (built ${db.buildTime}; max age ${maxAgeHours} hours)`);
    if (built > now + 15 * 60 * 1000) throw new Error(`${name} signature database build time is in the future (${db.buildTime})`);
  }
}
function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.files.map((item) => `| ${item.name.replaceAll('|', '\\|')} | ${item.sha256} | ${item.kind} |`).join('\n');
fs.writeFileSync(file.replace(/\.json$/i, '.md'), `# ClamAV scan report\n\n- Verdict: **${report.verdict}**\n- Engine: ${report.engineVersion ?? 'unavailable'}\n- Signatures updated: ${report.signatureUpdate?.status ?? 'failed'}\n- Signature update completed: ${report.signatureUpdate?.completedAt ?? 'unavailable'}\n- File count: ${report.fileCount}\n- Scan exit code: ${report.scanExitCode ?? 'not run'}\n- Error: ${report.error ?? 'none'}\n\n## Signature databases\n\n| Database | Version | Build time (UTC) | Signatures |\n|---|---:|---|---:|\n${Object.entries(report.databases ?? {}).map(([name, db]) => `| ${name} | ${db.version} | ${db.buildTime} | ${db.signatures} |`).join('\n') || '| unavailable | — | — | — |'}\n\n## Scanned files\n\n| File | SHA-256 | Kind |\n|---|---|---|\n${rows || '| none | — | — |'}\n`);
}

/** Update official ClamAV signatures, validate them, and scan every raw and packaged output. */
export function scanArtifacts({ rootDir, reportFile, repository = repositoryRoot, runner = runCommand, now = Date.now(), maxAgeHours = 48, dbDir = '/var/lib/clamav', certsDir = '/etc/clamav/certs', serviceCommand = 'systemctl', freshclamCommand = 'sudo', freshclamArgs = ['freshclam', '--stdout', '--verbose', `--cvdcertsdir=${certsDir}`] }) {
  const report = { generatedAt: new Date(now).toISOString(), engineVersion: null, signatureUpdate: null, databases: {}, fileCount: 0, scanExitCode: null, verdict: 'FAILED', error: null, files: [] };
  let temporary = null;
  try {
    const service = runner(serviceCommand, ['is-active', '--quiet', 'clamav-freshclam.service']);
    if (service.status === 0) {
      mustRun(runner, 'sudo', [serviceCommand, 'stop', 'clamav-freshclam.service'], 'Stopping clamav-freshclam service');
      const stopped = runner(serviceCommand, ['is-active', '--quiet', 'clamav-freshclam.service']);
      if (stopped.status !== 3) throw new Error(`clamav-freshclam service did not stop (status ${stopped.status})`);
    } else if (service.status !== 3) throw new Error(`Cannot determine clamav-freshclam service state (status ${service.status}): ${service.stderr}`);
    const update = runner(freshclamCommand, freshclamArgs);
    report.signatureUpdate = { status: update.status === 0 ? 'updated-or-current' : 'failed', completedAt: new Date().toISOString(), exitCode: update.status, output: `${update.stdout}\n${update.stderr}`.trim() };
    if (update.error || update.status !== 0 || hasCommandWarnings(`${update.stdout}\n${update.stderr}`)) throw new Error(`freshclam failed or reported a warning (exit ${update.status}): ${update.error || update.stderr || update.stdout}`);

    const engine = mustRun(runner, 'clamscan', ['--version'], 'ClamAV engine version');
    report.engineVersion = engine.stdout.trim().split(/[\r\n]/)[0];
    if (!/^ClamAV\s+\d/.test(report.engineVersion)) throw new Error(`Unexpected ClamAV engine version output: ${report.engineVersion}`);
    const engineVersion = report.engineVersion.match(/^ClamAV\s+(\d+)\.(\d+)\.(\d+)/);
    if (!engineVersion || Number(engineVersion[1]) < 1 || Number(engineVersion[1]) === 1 && Number(engineVersion[2]) < 5) throw new Error(`ClamAV 1.5.0 or newer is required for detached signature verification (found ${report.engineVersion})`);
    report.databases = signatureDatabases(dbDir, certsDir, runner);
    assertFresh(report.databases, now, maxAgeHours);

    const manifest = readJson(path.join(repository, 'config/themes.json'));
    const lock = readJson(path.join(repository, 'config/7zip.lock.json'));
    const expected = expectedMatrix(manifest, lock);
    const binaryRoot = path.join(rootDir, 'packages');
    const archiveRoot = path.join(rootDir, 'dist');
    const expectedBinaryNames = [];
    const expectedArchiveNames = [];
    for (const [arch, themes] of Object.entries(expected)) for (const theme of themes) {
      expectedBinaryNames.push(path.join(arch, theme.slug, theme.binary));
      expectedArchiveNames.push(`${theme.slug}-${arch}.7z`);
    }
    const actualBinaries = listFiles(binaryRoot).filter((file) => /\.(?:exe|dll)$/i.test(file)).map((file) => path.relative(binaryRoot, file));
    const expectedBinaries = expectedBinaryNames.sort();
    if (JSON.stringify(actualBinaries.sort()) !== JSON.stringify(expectedBinaries)) throw new Error(`Generated binary set incomplete or unexpected. Expected ${expectedBinaries.join(', ')}; found ${actualBinaries.join(', ') || '(none)'}`);
    const actualArchives = fs.existsSync(archiveRoot) ? fs.readdirSync(archiveRoot).filter((name) => name.toLowerCase().endsWith('.7z')).sort() : [];
    if (JSON.stringify(actualArchives) !== JSON.stringify(expectedArchiveNames.sort())) throw new Error(`Release archive set incomplete or unexpected. Expected ${expectedArchiveNames.join(', ')}; found ${actualArchives.join(', ') || '(none)'}`);

    const scanInputs = [];
    for (const rel of expectedBinaries) {
      const file = path.join(binaryRoot, rel), relative = path.posix.join('packages', rel.split(path.sep).join('/'));
      report.files.push({ name: relative, kind: 'generated-binary', sha256: hashFile(file) }); scanInputs.push(file);
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'clamav-theme-scan-'));
    for (const archiveName of expectedArchiveNames) {
      const archive = path.join(archiveRoot, archiveName), themeArch = archiveName.slice(0, -3).split('-');
      const arch = themeArch.at(-1), slug = themeArch.slice(0, -1).join('-');
      const theme = [...manifest.filetypes, manifest.ribbon].find((item) => item.slug === slug);
      const binary = theme.slug === manifest.ribbon.slug ? '7zFM.exe' : '7z.dll';
      const expectedEntries = [binary, '7-Zip-License.txt'].sort();
      const sevenZip = process.env.SEVENZIP_BIN || '7z';
      const listing = mustRun(runner, sevenZip, ['l', '-slt', archive], `Listing ${archiveName}`);
      const entries = archiveListing(listing.stdout, archiveName);
      if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) throw new Error(`${archiveName}: unexpected or incomplete packaged files: ${entries.join(', ')}`);
      const extractedDir = path.join(temporary, `${slug}-${arch}`); fs.mkdirSync(extractedDir, { recursive: true });
      mustRun(runner, sevenZip, ['x', '-y', `-o${extractedDir}`, archive], `Extracting ${archiveName}`);
      const extracted = path.join(extractedDir, binary);
      if (!fs.existsSync(extracted)) throw new Error(`${archiveName}: packaged ${binary} could not be extracted`);
      const raw = path.join(binaryRoot, arch, slug, binary);
      const archiveBinaryHash = hashFile(extracted), rawHash = hashFile(raw);
      if (archiveBinaryHash !== rawHash) throw new Error(`${archiveName}: packaged ${binary} differs from its raw generated binary`);
      report.files.push({ name: `dist/${archiveName}`, kind: 'release-archive', sha256: hashFile(archive) }); scanInputs.push(archive);
      report.files.push({ name: `${archiveName}!/${binary}`, kind: 'archive-binary', sourceArchive: `dist/${archiveName}`, sha256: archiveBinaryHash }); scanInputs.push(extracted);
    }
    report.fileCount = report.files.length;
    if (report.fileCount !== expectedBinaries.length + expectedArchiveNames.length * 2) throw new Error(`Incomplete scan set (${report.fileCount} files)`);
    const scan = runner('clamscan', [`--database=${dbDir}`, `--cvdcertsdir=${certsDir}`, '--verbose', '--scan-archive=yes', '--alert-exceeds-max=yes', '--alert-broken=yes', ...scanInputs]);
    report.scanExitCode = scan.status;
    report.scanOutput = `${scan.stdout}\n${scan.stderr}`.trim();
    const scannedCount = report.scanOutput.match(/^Scanned files:\s*(\d+)$/mi);
    const infectedCount = report.scanOutput.match(/^Infected files:\s*(\d+)$/mi);
    if (scannedCount) report.scanSummary = { scannedFiles: Number(scannedCount[1]), infectedFiles: Number(infectedCount?.[1] ?? 0) };
    if (scan.error || scan.status === 2 || scan.status !== 0 && scan.status !== 1) throw new Error(`ClamAV scanner error (exit ${scan.status}): ${scan.error || scan.stderr || scan.stdout}`);
    if (scan.status === 1 || /\bFOUND\b/.test(report.scanOutput)) throw new Error(`ClamAV detected a threat: ${report.scanOutput.match(/^.*\bFOUND\b.*$/m)?.[0] ?? 'infected file reported'}`);
    if (!scannedCount || !infectedCount || Number(scannedCount[1]) < scanInputs.length) throw new Error(`ClamAV scan appears incomplete (${scannedCount?.[1] ?? 'no summary'} scanned, ${infectedCount ? `${infectedCount[1]} infected` : 'no infection summary'}; ${scanInputs.length} explicit inputs)`);
    if (Number(infectedCount[1]) !== 0) throw new Error(`ClamAV reported ${infectedCount[1]} infected files despite a clean process exit`);
    if (/(?:WARNING|ERROR):|exceed(?:ed|s)?[^\n]*(?:limit|size)|(?:limit|size)[^\n]*exceed|not scanned|scan incomplete|unsupported archive|archive[^\n]*(?:failed|error|unsupported)|cannot (?:open|read|scan)|can't (?:open|read|scan)|skipped/i.test(report.scanOutput)) throw new Error(`ClamAV reported a warning or incomplete scan: ${report.scanOutput}`);
    report.verdict = 'CLEAN';
  } catch (error) { report.error = error.message; }
  finally {
    report.fileCount = report.files.length;
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    writeReport(reportFile, report);
  }
  if (report.verdict !== 'CLEAN') {
    const error = new Error(report.error || 'ClamAV scan failed'); error.report = report; throw error;
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
  const reportFile = path.resolve(arg('--report', 'clamav-report/report.json'));
  const dbDir = path.resolve(process.env.CLAMAV_DB_DIR || '/var/lib/clamav');
  const certsDir = path.resolve(process.env.CLAMAV_CVD_CERTS_DIR || '/etc/clamav/certs');
  const serviceCommand = process.env.CLAMAV_SYSTEMCTL_BIN || 'systemctl';
  const freshclamCommand = process.env.CLAMAV_FRESHCLAM_BIN || 'sudo';
  const freshclamArgs = process.env.CLAMAV_FRESHCLAM_BIN ? ['--stdout', '--verbose', `--cvdcertsdir=${certsDir}`, ...(process.env.CLAMAV_FRESHCLAM_CONFIG ? [`--config-file=${process.env.CLAMAV_FRESHCLAM_CONFIG}`] : [])] : ['freshclam', '--stdout', '--verbose', `--cvdcertsdir=${certsDir}`];
  try {
    const report = scanArtifacts({ rootDir: path.resolve(arg('--root', 'clamav-input')), reportFile, dbDir, certsDir, serviceCommand, freshclamCommand, freshclamArgs, maxAgeHours: Number(process.env.CLAMAV_MAX_AGE_HOURS || 48) });
    console.log(`ClamAV verdict: ${report.verdict}; ${report.fileCount} files hashed and scanned with ${report.engineVersion}.`);
  } catch (error) {
    console.error(`ClamAV gate failed: ${error.message}`); process.exitCode = 1;
  }
}
