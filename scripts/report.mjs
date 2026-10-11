import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVisualReports } from './reports.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = await generateVisualReports({ rootDir: root, outputDir: path.join(root, 'reports/generated') });
console.log(`Generated ${outputs.length} contact sheets under reports/generated`);
