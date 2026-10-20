import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARG_MAX_CHARS,
  createProgressWriter,
  summarizeToolArg,
  type TimedProgressEvent,
} from '../src/progress.js';

describe('summarizeToolArg', () => {
  it('uses the path for Read, Write and Edit', () => {
    expect(summarizeToolArg('Read', { file_path: 'src/x.ts' })).toBe(
      'src/x.ts',
    );
    expect(
      summarizeToolArg('Edit', { file_path: 'a.ts', old_string: 'z' }),
    ).toBe('a.ts');
  });

  it('uses the pattern, and the path if any, for Grep and Glob', () => {
    expect(summarizeToolArg('Grep', { pattern: 'foo' })).toBe('"foo"');
    expect(summarizeToolArg('Grep', { pattern: 'foo', path: 'src' })).toBe(
      '"foo" src',
    );
    expect(summarizeToolArg('Glob', { pattern: '**/*.ts' })).toBe('"**/*.ts"');
  });

  it('uses the command for Bash, on one line', () => {
    expect(summarizeToolArg('Bash', { command: 'npm test' })).toBe('npm test');
    expect(summarizeToolArg('Bash', { command: 'echo a\necho b' })).toBe(
      'echo a echo b',
    );
  });

  it('gives only the name (empty argument) for an unknown tool', () => {
    expect(summarizeToolArg('WebFetch', { url: 'https://x' })).toBe('');
    expect(summarizeToolArg('Read', undefined)).toBe('');
  });

  it('cuts the argument at 100 characters', () => {
    expect(ARG_MAX_CHARS).toBe(100);
    const long = 'a'.repeat(250);
    const out = summarizeToolArg('Bash', { command: long });
    expect(out).toHaveLength(100);
    expect(out.endsWith('…')).toBe(true);
    const exact = 'b'.repeat(100);
    expect(summarizeToolArg('Bash', { command: exact })).toBe(exact);
  });
});

describe('createProgressWriter', () => {
  let dir = '';

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per event, each with a timestamp', async () => {
    dir = await mkdtemp(join(tmpdir(), 'forge-progress-'));
    const write = createProgressWriter(
      dir,
      () => new Date('2026-10-20T12:00:00.000Z'),
    );
    await write({
      type: 'call-start',
      id: 'c1',
      label: 'dev',
      runner: 'claude-cli',
      model: null,
      canEdit: true,
    });
    await write({
      type: 'tool',
      id: 'c1',
      label: 'dev',
      name: 'Read',
      arg: 'src/x.ts',
    });

    const raw = await readFile(join(dir, 'progress.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l) as TimedProgressEvent);
    expect(events[0]).toMatchObject({
      at: '2026-10-20T12:00:00.000Z',
      type: 'call-start',
      model: null,
    });
    expect(events[1]).toMatchObject({
      at: '2026-10-20T12:00:00.000Z',
      type: 'tool',
      name: 'Read',
      arg: 'src/x.ts',
    });
    expect(raw).not.toContain('\u001b[');
  });
});
