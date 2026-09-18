import { readFileSync } from 'node:fs';
import { compareEvaluations } from '../dist/evaluation/report.js';

if (process.argv.length < 4) throw new Error('Usage: node scripts/compare-evaluations.mjs REPORT_A.json REPORT_B.json [REPORT_C.json]');
const reports = process.argv.slice(2).map(path => {
  const text = readFileSync(path, 'utf8');
  if (text.length > 8000000) throw new Error(`Report too large: ${path}`);
  return JSON.parse(text);
});
console.log(JSON.stringify(compareEvaluations(reports), null, 2));
