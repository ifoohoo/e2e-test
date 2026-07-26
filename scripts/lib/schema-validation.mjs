import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const cache = new Map();

export function schemaValidator(pluginRoot, schemaFile) {
  const key = `${pluginRoot}:${schemaFile}`;
  if (!cache.has(key)) {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    cache.set(key, ajv.compile(JSON.parse(readFileSync(join(pluginRoot, 'schemas', schemaFile), 'utf8'))));
  }
  return cache.get(key);
}

export function validateSchema(pluginRoot, schemaFile, value) {
  const validate = schemaValidator(pluginRoot, schemaFile);
  const valid = validate(value);
  return { valid, errors: valid ? [] : structuredClone(validate.errors || []) };
}
