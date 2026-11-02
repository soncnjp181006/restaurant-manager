// Patch helper: node tools/patch.cjs <file> <searchB64> <replaceB64> (base64 of UTF-8 text)
const fs = require('fs');
const [, , file, searchB64, replaceB64] = process.argv;
const search = Buffer.from(searchB64, 'base64').toString('utf8');
const replace = Buffer.from(replaceB64, 'base64').toString('utf8');
let content = fs.readFileSync(file, 'utf8');
if (!content.includes(search)) {
  console.error('SEARCH NOT FOUND in', file);
  process.exit(1);
}
content = content.replace(search, replace);
fs.writeFileSync(file, content);
console.log('patched', file);
