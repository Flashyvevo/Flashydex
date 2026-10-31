import { readFile } from 'node:fs/promises';
import process from 'node:process';
import Ajv2020 from '../packages/core/node_modules/ajv/dist/2020.js';

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  process.stderr.write('Usage: node scripts/validate-catalog-manifest.mjs <catalog-manifest.json>\n');
  process.exit(2);
}

const schema = JSON.parse(await readFile(new URL('../packages/schemas/json-schema/catalog-manifest.v1.schema.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(schema);
if (!validate(manifest)) {
  process.stderr.write(`Catalog manifest schema validation failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}\n`);
  process.exit(1);
}
process.stdout.write(`Catalog manifest schema validation passed: ${manifestPath}\n`);
