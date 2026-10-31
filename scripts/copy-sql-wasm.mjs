import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('node_modules/sql.js/dist/sql-wasm.wasm');
const destination = resolve('apps/mobile/public/assets/sql-wasm.wasm');
await mkdir(resolve('apps/mobile/public/assets'), { recursive: true });
await stat(source);
await copyFile(source, destination);
console.log(`Copied ${source} -> ${destination}`);
