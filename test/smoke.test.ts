import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package', () => {
  it('uses the scoped package name', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      name: string;
    };
    expect(pkg.name).toBe('@jessicajabes/forge');
  });
});
