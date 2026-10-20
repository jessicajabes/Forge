import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logCalls, type CallRecord } from '../src/calls.js';
import type { RunnerFactory } from '../src/runner.js';

async function lines(path: string): Promise<CallRecord[]> {
  return (await readFile(path, 'utf-8'))
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CallRecord);
}

describe('logCalls', () => {
  it('records one line per call, with sizes and the model, and never the prompt text', async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), 'forge-calls-')),
      'calls.jsonl',
    );
    const factory: RunnerFactory = () => async (req) =>
      `resposta a ${req.prompt.length}`;
    const make = logCalls(factory, path);
    const runner = make({ cwd: '/x', model: 'm1', runner: 'copilot-cli' });
    expect(
      await runner({ prompt: 'SEGREDO-NO-PROMPT', files: [], canEdit: true }),
    ).toBe('resposta a 17');
    await make({ cwd: '/x' })({ prompt: 'p', files: [], canEdit: false });

    const records = await lines(path);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      runner: 'copilot-cli',
      model: 'm1',
      canEdit: true,
      promptChars: 17,
      ok: true,
    });
    expect(records[1]).toMatchObject({
      runner: 'claude-cli',
      model: null,
      canEdit: false,
    });
    expect(await readFile(path, 'utf-8')).not.toContain('SEGREDO-NO-PROMPT');
  });

  it('records a failed call and rethrows the error', async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), 'forge-calls-')),
      'calls.jsonl',
    );
    const make = logCalls(
      () => async () => {
        throw new Error('falhou');
      },
      path,
    );
    await expect(
      make({ cwd: '/x' })({ prompt: 'p', files: [], canEdit: false }),
    ).rejects.toThrow('falhou');
    expect((await lines(path))[0]).toMatchObject({ ok: false, outputChars: 0 });
  });
});
