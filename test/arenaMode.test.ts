import { describe, expect, it } from 'vitest';
import { resolveArenaMode } from '../src/arenaMode.js';
import { UsageError } from '../src/cli.js';
import { parseConfig } from '../src/config.js';

function config(enabled: boolean, candidates: number) {
  const c = parseConfig('');
  c.dev.arena.enabled = enabled;
  c.dev.arena.candidates = candidates;
  return c;
}

describe('resolveArenaMode', () => {
  it('is off by default', () => {
    expect(resolveArenaMode(parseConfig(''), 'complete')).toEqual({
      enabled: false,
      candidates: 1,
    });
  });

  it('is off when only candidates is set', () => {
    expect(resolveArenaMode(config(false, 3), 'complete').enabled).toBe(false);
  });

  it('is on when enabled with more than one candidate', () => {
    expect(resolveArenaMode(config(true, 3), 'complete')).toEqual({
      enabled: true,
      candidates: 3,
    });
  });

  it('is off with a single candidate', () => {
    expect(resolveArenaMode(config(true, 1), 'complete').enabled).toBe(false);
  });

  it('is off for a trivial task', () => {
    expect(resolveArenaMode(config(true, 3), 'trivial').enabled).toBe(false);
  });

  it('--arena turns it on with the configured candidates', () => {
    expect(
      resolveArenaMode(config(false, 3), 'complete', { arena: {} }),
    ).toEqual({ enabled: true, candidates: 3 });
  });

  it('--arena <n> overrides candidates for this run only', () => {
    const c = config(false, 3);
    expect(
      resolveArenaMode(c, 'complete', { arena: { candidates: 4 } }),
    ).toEqual({ enabled: true, candidates: 4 });
    expect(c.dev.arena.candidates).toBe(3);
  });

  it('--arena 1 runs a plain Dev', () => {
    expect(
      resolveArenaMode(config(true, 3), 'complete', {
        arena: { candidates: 1 },
      }).enabled,
    ).toBe(false);
  });

  it('--no-arena turns it off even when enabled in config', () => {
    expect(
      resolveArenaMode(config(true, 3), 'complete', { noArena: true }),
    ).toEqual({ enabled: false, candidates: 1 });
  });

  it('--arena with --no-arena throws UsageError', () => {
    expect(() =>
      resolveArenaMode(config(false, 3), 'complete', {
        arena: {},
        noArena: true,
      }),
    ).toThrow(UsageError);
  });

  it('--arena is still off for a trivial task', () => {
    expect(
      resolveArenaMode(config(false, 3), 'trivial', { arena: {} }).enabled,
    ).toBe(false);
  });
});
