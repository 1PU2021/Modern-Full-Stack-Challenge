import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
describe('Compose web service', () => {
  it('builds the web package and exposes Vite', () => {
    const text = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
    expect(text).toMatch(/web:\n\s+build: \.\/web/);
    expect(text).toMatch(/5173:5173/);
  });
});
