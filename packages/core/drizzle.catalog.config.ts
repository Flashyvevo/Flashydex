import { defineConfig } from 'drizzle-kit';

// CATALOG migration chain only (packs). The USER chain gets its own config (drizzle.user.config.ts, data builder).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/catalog-schema.ts',
  out: './migrations/catalog'
});
