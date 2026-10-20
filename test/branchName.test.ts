import { describe, expect, it } from 'vitest';
import { branchName } from '../src/branchName.js';

describe('branchName', () => {
  it('gives the same name for the same run id', () => {
    const id = '2026-10-20-os-dados-do-revisor';
    expect(branchName(id, [])).toBe(branchName(id, []));
  });

  it('keeps the forge/ prefix and a git-safe shape', () => {
    expect(branchName('2026-10-20-x', [])).toMatch(/^forge\/[a-z]+-[a-z]+$/);
  });

  it('gives different names to different run ids', () => {
    const names = new Set(
      Array.from({ length: 20 }, (_, i) =>
        branchName(`2026-10-20-run-${i}`, []),
      ),
    );
    expect(names.size).toBeGreaterThan(1);
  });

  it('gives a different name when the branch already exists', () => {
    const id = '2026-10-20-colisao';
    const first = branchName(id, []);
    const second = branchName(id, [first]);
    expect(second).not.toBe(first);
    expect(second.startsWith('forge/')).toBe(true);
    expect(branchName(id, [first, second])).not.toBe(second);
  });
});
