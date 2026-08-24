/** Host ABI gate: better-sqlite3 must load under host Node (ABI 141). */
const Database = require('better-sqlite3');
if (process.versions.modules !== '141') {
  throw new Error(`host ABI mismatch: modules=${process.versions.modules}, expected 141`);
}
new Database(':memory:').prepare('select 1').get();
console.log('HOST_ABI_OK');
