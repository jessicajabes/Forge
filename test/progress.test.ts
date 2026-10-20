import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARG_MAX_CHARS,
  createProgressWriter,
  maskEvent,
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

  it('writes only the last 2 KB of a failed call stderr, with secrets masked', async () => {
    dir = await mkdtemp(join(tmpdir(), 'forge-progress-'));
    const write = createProgressWriter(dir);
    const stderr = `${'x'.repeat(5000)}\nAPI_TOKEN=abc123 Authorization: Bearer xyz789`;
    await write({
      type: 'call-end',
      id: 'c1',
      label: 'dev',
      ok: false,
      ms: 1,
      stderr,
    });
    const raw = await readFile(join(dir, 'progress.jsonl'), 'utf-8');
    const event = JSON.parse(raw) as TimedProgressEvent & { stderr: string };
    expect(event.stderr.length).toBeLessThanOrEqual(2048);
    expect(event.stderr).toContain('API_TOKEN=***');
    expect(event.stderr).toContain('Bearer ***');
    expect(raw).not.toContain('abc123');
    expect(raw).not.toContain('xyz789');
  });
});

describe('maskSecrets in tool arguments', () => {
  it('hides tokens in a Bash command before it is summarized', () => {
    const out = summarizeToolArg('Bash', {
      command: 'FOO_TOKEN=s3cr3t curl -H "Authorization: Bearer abc.def" x',
    });
    expect(out).toContain('FOO_TOKEN=***');
    expect(out).toContain('Bearer ***');
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('abc.def');
  });
});

describe('maskEvent', () => {
  it('masks the reason of a stage and of a call-end', () => {
    const stage = maskEvent({
      type: 'stage',
      stage: 'dev',
      phase: 'end',
      index: 1,
      total: 2,
      ok: false,
      reason: 'falhou: API_TOKEN=abc123',
    });
    expect(stage).toMatchObject({ reason: 'falhou: API_TOKEN=***' });
    const end = maskEvent({
      type: 'call-end',
      id: 'c1',
      label: 'dev',
      ok: false,
      ms: 1,
      reason: 'Authorization: Bearer xyz',
    });
    expect(end).toMatchObject({ reason: 'Authorization: Bearer ***' });
  });

  it('masks before cutting the stderr tail, so a cut inside KEY=value leaks nothing', () => {
    const stderr = `${'x'.repeat(2040)} SECRET_KEY=abcdefghij`;
    const out = maskEvent({
      type: 'call-end',
      id: 'c1',
      label: 'dev',
      ok: false,
      ms: 1,
      stderr,
    });
    expect(out.type === 'call-end' && out.stderr).toContain('SECRET_KEY=***');
    expect(JSON.stringify(out)).not.toContain('abcdefghij');
  });
});

describe('createProgressWriter failures', () => {
  it('tells onError about the first failed write only', async () => {
    const errors: unknown[] = [];
    const write = createProgressWriter(
      join(tmpdir(), 'forge-missing-dir-xyz'),
      undefined,
      (error) => errors.push(error),
    );
    const event = {
      type: 'activity',
      id: 'c1',
      label: 'dev',
    } as const;
    await write(event);
    await write(event);
    expect(errors).toHaveLength(1);
  });
});
