/**
 * apply-patch.mjs — apply exact string replacements to a UTF-8 file.
 * Usage: node scripts/apply-patch.mjs <file> <markerFile>
 * The marker file is JSON: { "replacements": [ { "old": "...", "new": "..." } ] }
 * Every replacement must match exactly once (or replaceAll: true).
 * Matching happens on LF-normalized text; the file's original line-ending
 * style (CRLF vs LF) is preserved on write-back. UTF-8 without BOM.
 */
import fs from 'node:fs';

const [, , filePath, markerPath] = process.argv;
if (!filePath || !markerPath) {
  console.error('usage: node scripts/apply-patch.mjs <file> <marker.json>');
  process.exit(2);
}

const raw = fs.readFileSync(filePath, 'utf8');
const usesCrlf = raw.includes('\r\n');
const source = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;
const original = source;

const markers = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
const replacements = Array.isArray(markers) ? markers : markers.replacements;
if (!Array.isArray(replacements) || replacements.length === 0) {
  console.error('marker file must contain a "replacements" array');
  process.exit(2);
}

let current = source;
for (const [index, entry] of replacements.entries()) {
  const { old: oldText, new: newText, replaceAll } = entry;
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    console.error(`replacement ${index}: "old" and "new" must be strings`);
    process.exit(2);
  }
  const count = current.split(oldText).length - 1;
  if (count === 0) {
    console.error(`replacement ${index}: old text not found`);
    process.exit(1);
  }
  if (count > 1 && !replaceAll) {
    console.error(`replacement ${index}: old text found ${count} times; use replaceAll`);
    process.exit(1);
  }
  current = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
  console.log(`replacement ${index}: applied (${count} occurrence${count > 1 ? 's' : ''})`);
}

if (current === original) {
  console.error('no change');
  process.exit(1);
}
const output = usesCrlf ? current.replace(/\n/g, '\r\n') : current;
fs.writeFileSync(filePath, output, 'utf8');
console.log(`patched ${filePath}`);