// Generates the small .zst fixtures for bounded-decoder.test.ts (Node >= 22.15 zlib.zstdCompressSync). Output is committed.
import { zstdCompressSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
const dir = new URL('../src/platform/pack-install/fixtures/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('zeros-64mib.zst', dir), zstdCompressSync(Buffer.alloc(64 * 1024 * 1024)));
console.log('wrote zeros-64mib.zst');
