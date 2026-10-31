import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: [".next/**", "node_modules/**", "public/sw.js", "playwright-report/**", "test-results/**"],
  },
]);
