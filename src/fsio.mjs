import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
export const ROOT_DIR = ROOT;
const p = (...s) => path.join(ROOT, ...s);
export const readRule = (n) => JSON.parse(readFileSync(p('rules', n), 'utf8'));
export function walk(dir, base = '') {
  const d = p('data', base), out = [];
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d)) {
    const f = path.join(d, e), rel = base ? `${base}/${e}` : e;
    if (statSync(f).isDirectory()) out.push(...walk(dir, rel));
    else if (/\.(md|csv|txt|json)$/.test(e)) out.push({ path: rel, text: readFileSync(f, 'utf8') });
  }
  return out;
}
export const loadDataFiles = () => walk('data');
export const groundTruth = () => Object.fromEntries(readRule('ground_truth_labels.json').map((e) => [e.file, e.sensitivity]));
export const readData = (rel) => readFileSync(path.join(ROOT, 'data', rel), 'utf8');
