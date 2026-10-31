// `npm run schemas:generate`: rewrites json-schema/*.json from the zod schemas (runs the generator test in update mode).
import { spawnSync } from 'node:child_process';
const result = spawnSync('npx', ['vitest', 'run', 'test/json-schema.test.ts'], {
  cwd: new URL('../../core/', import.meta.url),
  env: { ...process.env, UPDATE_SCHEMAS: '1' },
  stdio: 'inherit',
  shell: true
});
process.exit(result.status ?? 1);
