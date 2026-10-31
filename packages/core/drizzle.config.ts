import { defineConfig } from 'drizzle-kit';

// USER migration chain (flashydex-user.db). The CATALOG chain has its own config (drizzle.catalog.config.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/user-schema.ts',
  out: './migrations/user'
});
