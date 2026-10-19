import { describe, expect, it } from 'vitest';
import { createFakeRunner } from './fakeRunner.js';

describe('fake runner', () => {
  it('returns the canned responses in order and records canEdit', async () => {
    const { runner, calls } = createFakeRunner(['one', 'two']);
    expect(await runner({ prompt: 'a', files: [], canEdit: false })).toBe(
      'one',
    );
    expect(await runner({ prompt: 'b', files: ['x.ts'], canEdit: true })).toBe(
      'two',
    );
    expect(calls.map((c) => c.canEdit)).toEqual([false, true]);
    expect(calls[1]?.files).toEqual(['x.ts']);
  });

  it('computes a response from the request when given a function', async () => {
    const { runner } = createFakeRunner([(req) => req.prompt.toUpperCase()]);
    expect(await runner({ prompt: 'hi', files: [], canEdit: false })).toBe(
      'HI',
    );
  });

  it('fails when the script runs out of responses', async () => {
    const { runner } = createFakeRunner(['only']);
    await runner({ prompt: 'a', files: [], canEdit: false });
    await expect(
      runner({ prompt: 'b', files: [], canEdit: false }),
    ).rejects.toThrow(/no response left/);
  });
});
