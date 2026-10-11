import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function verifyScannedArtifact(rootDir, report) {
  if (report.verdict !== 'CLEAN') throw new Error(`Refusing publication: scan verdict is ${report.verdict}`);
  const expected = new Map(report.files.filter((item) => item.kind === 'generated-binary' || item.kind === 'release-archive').map((item) => [item.name, item.sha256]));
  if (!expected.size) throw new Error('Scan report has no raw binary or release archive hashes');
  for (const [relative, digest] of expected) {
    const file = path.join(rootDir, ...relative.split('/'));
    if (!fs.existsSync(file)) throw new Error(`Scanned artifact is missing after download: ${relative}`);
    const actual = hash(file);
    if (actual !== digest) throw new Error(`Scanned artifact checksum mismatch: ${relative} (${actual} != ${digest})`);
  }
  const actualFiles = [];
  for (const base of ['packages', 'dist']) {
    const root = path.join(rootDir, base);
    if (!fs.existsSync(root)) continue;
    const visit = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? visit(full) : entry.isFile() && /\.(?:exe|dll|7z)$/i.test(entry.name) ? [path.relative(rootDir, full).split(path.sep).join('/')] : [];
    });
    actualFiles.push(...visit(root));
  }
  const expectedNames = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles.sort()) !== JSON.stringify(expectedNames)) throw new Error(`Downloaded output set differs from scan report (expected ${expectedNames.join(', ')}; found ${actualFiles.join(', ')})`);
  return { verifiedFiles: expected.size, hashes: Object.fromEntries(expected) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || 'release-input');
  const reportFile = path.resolve(process.argv[3] || 'clamav-report/report.json');
  const verification = verifyScannedArtifact(root, JSON.parse(fs.readFileSync(reportFile, 'utf8')));
  console.log(`Verified ${verification.verifiedFiles} binaries and archives are byte-identical to the ClamAV scan inputs.`);
}
