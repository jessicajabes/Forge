import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PreflightError, preflight } from '../src/preflight.js';
import { createRun, ensureLocalExclude, slugify } from '../src/runs.js';
import { makeRepo } from './helpers.js';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof PreflightError
      ? error.code
      : `other: ${String(error)}`;
  }
  return undefined;
}

describe('preflight', () => {
  it('passes on a clean repo, on a feature branch, with a TTY', async () => {
    const cwd = await makeRepo();
    const result = await preflight({ cwd, isTTY: true });
    expect(result.excluded).toEqual(['.workflow/', '.workflow.yml']);
    await result.release();
  });

  it('refuses without a TTY', async () => {
    expect(
      await codeOf(preflight({ cwd: await makeRepo(), isTTY: false })),
    ).toBe('no-tty');
  });

  it('refuses outside a git repo', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-nogit-'));
    expect(await codeOf(preflight({ cwd, isTTY: true }))).toBe('not-git');
  });

  it('refuses a dirty tree', async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, 'new.txt'), 'x');
    expect(await codeOf(preflight({ cwd, isTTY: true }))).toBe('dirty-tree');
  });

  it('does not count .workflow.yml as a dirty tree', async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, '.workflow.yml'), 'review_mode: final\n');
    const result = await preflight({ cwd, isTTY: true });
    await result.release();
  });

  it.each(['main', 'master'])('refuses to run on %s', async (branch) => {
    expect(
      await codeOf(preflight({ cwd: await makeRepo(branch), isTTY: true })),
    ).toBe('protected-branch');
  });

  it('refuses a second active run and accepts a new one after release', async () => {
    const cwd = await makeRepo();
    const first = await preflight({ cwd, isTTY: true });
    // the lock belongs to this live process, so a second preflight must see it as taken
    // (a different pid is simulated by rewriting the lock file with the parent pid)
    await writeFile(join(cwd, '.workflow', 'lock'), String(process.ppid));
    expect(await codeOf(preflight({ cwd, isTTY: true }))).toBe('locked');
    await first.release();
    const again = await preflight({ cwd, isTTY: true });
    await again.release();
  });

  it('takes over a lock left by a dead process', async () => {
    const cwd = await makeRepo();
    const first = await preflight({ cwd, isTTY: true });
    await writeFile(join(cwd, '.workflow', 'lock'), '2147483646');
    const second = await preflight({ cwd, isTTY: true });
    await second.release();
    await first.release();
  });
});

describe('local exclude', () => {
  it('does not duplicate the lines across runs', async () => {
    const cwd = await makeRepo();
    await ensureLocalExclude(cwd);
    expect(await ensureLocalExclude(cwd)).toEqual([]);
    const text = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf-8');
    expect(text.match(/^\.workflow\/$/gm)).toHaveLength(1);
    expect(text.match(/^\.workflow\.yml$/gm)).toHaveLength(1);
  });
});

describe('runs', () => {
  it('slugifies a task description', () => {
    expect(slugify('Adicionar login com Google!')).toBe(
      'adicionar-login-com-google',
    );
    expect(slugify('???')).toBe('tarefa');
  });

  it('creates one folder per run and never reuses a name', async () => {
    const cwd = await makeRepo();
    const now = new Date('2026-10-19T12:00:00Z');
    const a = await createRun(cwd, 'Adicionar login', now);
    const b = await createRun(cwd, 'Adicionar login', now);
    expect(a.id).toBe('2026-10-19-adicionar-login');
    expect(b.id).toBe('2026-10-19-adicionar-login-2');
    expect(a.dir).not.toBe(b.dir);
  });
});

describe('preflight when resuming', () => {
  it('accepts a dirty tree only with allowDirty', async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, 'wip.txt'), 'trabalho em andamento');
    expect(await codeOf(preflight({ cwd, isTTY: true }))).toBe('dirty-tree');
    const result = await preflight({ cwd, isTTY: true, allowDirty: true });
    await result.release();
  });

  it('still refuses main and master when resuming', async () => {
    const cwd = await makeRepo('main');
    expect(
      await codeOf(preflight({ cwd, isTTY: true, allowDirty: true })),
    ).toBe('protected-branch');
  });
});

describe('run date', () => {
  it('uses the machine time zone: 21h18 in Brasília is not dated tomorrow', async () => {
    const previous = process.env['TZ'];
    process.env['TZ'] = 'America/Sao_Paulo';
    try {
      const cwd = await makeRepo();
      const run = await createRun(
        cwd,
        'fuso',
        new Date('2026-10-20T00:18:00Z'),
      );
      expect(run.id).toBe('2026-10-19-fuso');
    } finally {
      if (previous === undefined) delete process.env['TZ'];
      else process.env['TZ'] = previous;
    }
  });
});
