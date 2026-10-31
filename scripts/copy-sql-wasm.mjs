// Copies sql-wasm.wasm into apps/mobile/public/assets/ (path jeep-sqlite requests).
//
// IMPORTANT: jeep-sqlite 2.8.0 bundles its own sql.js JS glue (an sql.js 1.11/1.12-era build).
// The wasm must come from the SAME sql.js generation (exports start at "I"). sql.js >= 1.13
// changed the wasm import/export table and fails with
//   LinkError: Import #34 "a" "I": function import requires a callable
// apps/mobile pins sql.js 1.12.0 for exactly this reason; resolve it from apps/mobile, not the
// hoisted root copy (drizzle-orm's optional peer pulls 1.15.x into the root node_modules).
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(resolve('apps/mobile/package.json'));
const pkgPath = require.resolve('sql.js/package.json');
const { version } = require(pkgPath);
if (version !== '1.12.0') {
  throw new Error(`apps/mobile must resolve sql.js 1.12.0 (matches jeep-sqlite 2.8.0 glue), got ${version}`);
}
const source = resolve(dirname(pkgPath), 'dist/sql-wasm.wasm');
const destination = resolve('apps/mobile/public/assets/sql-wasm.wasm');
await mkdir(resolve('apps/mobile/public/assets'), { recursive: true });
await stat(source);
await copyFile(source, destination);
console.log(`Copied ${source} -> ${destination} (sql.js ${version})`);
