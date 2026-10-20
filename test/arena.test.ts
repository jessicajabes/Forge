import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArenaEscalation,
  runArena,
  runChecks,
  safeCommands,
} from '../src/arena.js';
import { parseConfig } from '../src/config.js';
import { git } from '../src/git.js';
import type { RunContext } from '../src/orchestrator.js';
import type { Runner, RunnerFactory } from '../src/runner.js';
import { createRun, ensureLocalExclude } from '../src/runs.js';
import { splitBatches } from '../src/steps/dev.js';
import { parseTasks } from '../src/artifacts.js';
import { createFakeIO } from './fakeIO.js';
import { makeRepo } from './helpers.js';

const TASKS = `# Tarefas

## T1: Tarefa um
- **Arquivos**: src/a.ts
- **O que fazer**: Fazer um.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const verdict = (base: number | null, convergence = false) =>
  JSON.stringify({
    scores: [
      { candidate: 1, criteria: [{ criterion: 'c', score: 4, note: 'ok' }] },
    ],
    base,
    convergence,
    rationale: 'porque sim',
  });
const NOTE = `Integrei.\n\n## Arena note\n- **Base**: 2\n- **Grafts**: nenhum\n`;

type Opts = {
  yml?: string;
  judge?: string | (() => string);
  integrate?: (cwd: string) => Promise<string>;
  candidate?: (index: number, cwd: string) => Promise<string>;
};

async function setup(opts: Opts = {}) {
  const cwd = await makeRepo();
  await ensureLocalExclude(cwd);
  const run = await createRun(cwd, 'arena');
  await writeFile(join(run.dir, 'tasks.md'), TASKS);
  await writeFile(join(run.dir, 'spec.md'), '# Spec: x\n');
  const candidatePrompts: string[] = [];
  const factoryCalls: Parameters<RunnerFactory>[0][] = [];
  const insideWorktree: boolean[] = [];
  const runnerPrompts: string[] = [];

  const ctxRunner: Runner = async (req) => {
    runnerPrompts.push(req.prompt);
    if (req.prompt.includes('preparing an arena'))
      return '1. Cumpre os critérios\n2. Segue o padrão';
    if (req.prompt.includes('You are the judge')) {
      const j = opts.judge ?? verdict(2);
      return typeof j === 'function' ? j() : j;
    }
    if (req.prompt.includes('You integrate')) {
      return opts.integrate
        ? opts.integrate(cwd)
        : (await writeFile(join(cwd, 'integrated.txt'), 'x'), NOTE);
    }
    throw new Error('prompt inesperado no runner principal');
  };
  const makeRunner: RunnerFactory = (o) => {
    factoryCalls.push(o);
    return async (req) => {
      candidatePrompts.push(req.prompt);
      const n = Number(basename(o.cwd).replace('candidato-', ''));
      insideWorktree.push(existsSync(join(o.cwd, '.git')));
      if (opts.candidate) return opts.candidate(n, o.cwd);
      await writeFile(join(o.cwd, `cand-${n}.txt`), `candidato ${n}\n`);
      return `relatório do candidato ${n}`;
    };
  };
  const config = parseConfig(
    opts.yml ??
      'dev:\n  allowed_commands: [node --version]\n  check_commands: [node --version]\n',
  );
  const ctx: RunContext = {
    cwd,
    task: 'arena',
    size: 'complete',
    run,
    config,
    runner: ctxRunner,
  };
  const batch = splitBatches(parseTasks(TASKS).tasks, 'final')[0]!;
  const io = createFakeIO([]);
  return {
    ctx,
    batch,
    io,
    makeRunner,
    candidatePrompts,
    factoryCalls,
    insideWorktree,
    runnerPrompts,
    arenaDir: join(run.dir, 'arena', '1'),
  };
}

describe('arena', () => {
  it('runs N candidates in worktrees, judges, integrates, writes the note and removes the worktrees', async () => {
    const s = await setup();
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });

    expect(s.factoryCalls).toHaveLength(3);
    expect(s.insideWorktree).toEqual([true, true, true]);
    expect(s.factoryCalls.map((c) => basename(c.cwd)).sort()).toEqual([
      'candidato-1',
      'candidato-2',
      'candidato-3',
    ]);
    expect(existsSync(join(s.ctx.cwd, 'integrated.txt'))).toBe(true);

    const note = await readFile(join(s.arenaDir, 'arena.md'), 'utf-8');
    expect(note).toContain('Iniciados: 3. Entregaram: 3.');
    expect(note).toContain('base recomendada: candidato 2');
    expect(note).toContain('## Arena note');
    expect(note).toContain('`node --version`: passou');
    expect(existsSync(join(s.arenaDir, 'rubric.md'))).toBe(true);

    // worktrees are gone, from disk and from git
    expect(existsSync(join(s.arenaDir, 'candidato-1'))).toBe(false);
    expect(
      (await git(s.ctx.cwd, ['worktree', 'list'])).split('\n'),
    ).toHaveLength(1);
  });

  it('never shows the rubric to the candidates', async () => {
    const s = await setup();
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    for (const prompt of s.candidatePrompts) {
      expect(prompt).not.toContain('Cumpre os critérios');
      expect(prompt).toContain('## T1: Tarefa um');
    }
  });

  it('hands the judge and the integrator every candidate report', async () => {
    const s = await setup();
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    const judge = s.runnerPrompts.find((p) => p.includes('You are the judge'));
    expect(judge).toContain('relatório do candidato 1');
    expect(judge).toContain('relatório do candidato 3');
    expect(judge).toContain('Cumpre os critérios');
  });

  it('continues with N-1 when a candidate drops out, and records the dropout', async () => {
    const s = await setup({
      candidate: async (n, cwd) => {
        if (n === 2) throw new Error('travou');
        await writeFile(join(cwd, `cand-${n}.txt`), 'x');
        return `rel ${n}`;
      },
    });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    const note = await readFile(join(s.arenaDir, 'arena.md'), 'utf-8');
    expect(note).toContain('Entregaram: 2.');
    expect(note).toContain('Desistência do candidato 2: travou');
    expect(s.io.output()).toContain('Candidato 2 desistiu');
  });

  it('a candidate that changes nothing counts as a dropout', async () => {
    const s = await setup({
      candidate: async (n, cwd) => {
        if (n !== 1) await writeFile(join(cwd, `cand-${n}.txt`), 'x');
        return `rel ${n}`;
      },
    });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    expect(await readFile(join(s.arenaDir, 'arena.md'), 'utf-8')).toContain(
      'Desistência do candidato 1: não mudou nada',
    );
  });

  it('with one survivor, that candidate is the base: no judge, no integrator, its change is applied', async () => {
    const s = await setup({
      candidate: async (n, cwd) => {
        if (n !== 3) throw new Error('falhou');
        await writeFile(join(cwd, 'only.txt'), 'único\n');
        return 'rel 3';
      },
    });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    expect(
      s.runnerPrompts.some(
        (p) => p.includes('You are the judge') || p.includes('You integrate'),
      ),
    ).toBe(false);
    expect(await readFile(join(s.ctx.cwd, 'only.txt'), 'utf-8')).toBe(
      'único\n',
    );
    expect(await readFile(join(s.arenaDir, 'arena.md'), 'utf-8')).toContain(
      'candidato único',
    );
  });

  it('with no survivor, escalates to the human and still removes the worktrees', async () => {
    const s = await setup({
      candidate: async () => {
        throw new Error('falhou');
      },
    });
    await expect(
      runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io }),
    ).rejects.toBeInstanceOf(ArenaEscalation);
    expect(
      (await git(s.ctx.cwd, ['worktree', 'list'])).split('\n'),
    ).toHaveLength(1);
  });

  it('total divergence stops the Forge: when the judge finds no base, and when the integrator says so', async () => {
    const judged = await setup({ judge: verdict(null) });
    await expect(
      runArena(judged.ctx, judged.batch, {
        makeRunner: judged.makeRunner,
        io: judged.io,
      }),
    ).rejects.toThrow(/divergência total/);
    expect(existsSync(join(judged.arenaDir, 'candidato-1'))).toBe(false);

    const integrated = await setup({
      integrate: async () => 'ARENA-DIVERGENCE\nnão há base',
    });
    await expect(
      runArena(integrated.ctx, integrated.batch, {
        makeRunner: integrated.makeRunner,
        io: integrated.io,
      }),
    ).rejects.toThrow(/divergência total/);
  });

  it('records convergence from the judge', async () => {
    const s = await setup({ judge: verdict(1, true) });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    expect(await readFile(join(s.arenaDir, 'arena.md'), 'utf-8')).toContain(
      'os candidatos convergem',
    );
  });

  it('goes on without the verdict when the judge answers badly three times', async () => {
    const s = await setup({ judge: 'lixo' });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    expect(await readFile(join(s.arenaDir, 'arena.md'), 'utf-8')).toContain(
      'o juiz não respondeu de forma válida',
    );
    expect(existsSync(join(s.ctx.cwd, 'integrated.txt'))).toBe(true);
  });

  it('never gives the candidates git worktree or git push', async () => {
    expect(
      safeCommands([
        'npm test',
        'git push origin x',
        'git worktree add y',
        'git status',
      ]),
    ).toEqual(['npm test', 'git status']);
    const s = await setup({
      yml: 'dev:\n  allowed_commands: [node --version, git push origin main, git worktree add x]\n',
    });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    for (const call of s.factoryCalls)
      expect(call.allowedCommands).toEqual(['node --version']);
  });

  it('uses a different model per candidate when dev.arena.models is set', async () => {
    const s = await setup({
      yml: 'dev:\n  allowed_commands: [node --version]\n  arena:\n    models: [m-a, m-b, m-c]\n',
    });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    const byDir = Object.fromEntries(
      s.factoryCalls.map((c) => [basename(c.cwd), c.model]),
    );
    expect(byDir).toEqual({
      'candidato-1': 'm-a',
      'candidato-2': 'm-b',
      'candidato-3': 'm-c',
    });
  });
});

describe('arena models', () => {
  it('falls back to the Dev model and runner when dev.arena.models is not set', async () => {
    const s = await setup({
      yml: 'steps:\n  dev: { runner: claude-cli, model: m-dev }\ndev:\n  allowed_commands: [node --version]\n',
    });
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    for (const call of s.factoryCalls) {
      expect(call.model).toBe('m-dev');
      expect(call.runner).toBe('claude-cli');
    }
  });
});

describe('arena checks', () => {
  it('run the check_commands, not the allowed_commands, after the worktrees are gone', async () => {
    const probe = (dir: string) => `test ! -e ${dir}`;
    const s = await setup({
      yml: 'dev:\n  allowed_commands: [node --version]\n  check_commands: [node --version]\n',
    });
    // A check that passes only when the first worktree no longer exists
    s.ctx.config.dev.check_commands = [
      probe(join(s.arenaDir, 'candidato-1')),
      'node --version',
    ];
    await runArena(s.ctx, s.batch, { makeRunner: s.makeRunner, io: s.io });
    const note = await readFile(join(s.arenaDir, 'arena.md'), 'utf-8');
    expect(note).toContain('candidato-1`: passou');
    expect(note).toContain('`node --version`: passou');
  });

  it('default to npm test and npm run lint, without the formatter of allowed_commands', () => {
    const dev = parseConfig('').dev;
    expect(dev.check_commands).toEqual(['npm test', 'npm run lint']);
    expect(dev.allowed_commands).toContain('npx prettier');
  });
});

describe('runChecks', () => {
  it('does not hang on a command that reads stdin until it ends', async () => {
    // `cat` with no file reads stdin, like `prettier` with no file
    const results = await runChecks(process.cwd(), ['cat']);
    expect(results).toEqual([{ command: 'cat', ok: true, detail: 'passou' }]);
  }, 10_000);
});
