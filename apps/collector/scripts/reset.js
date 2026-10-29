'use strict';
// Delete data/ and cold/ for a clean demo.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
for (const dir of ['data', 'cold']) {
  fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  console.log(`removed ${dir}/`);
}
