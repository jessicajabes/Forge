import { execFileSync } from 'node:child_process';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { RunContext } from '../src/orchestrator.js';
import type { Runner } from '../src/runner.js';
import { createRun } from '../src/runs.js';
import { SubagentEscalation } from '../src/subagents.js';
import { createReconStage } from '../src/steps/recon.js';
import { createFakeIO } from './fakeIO.js';
import { createFakeRunner } from './fakeRunner.js';
import { makeRepo } from './helpers.js';

const CONTEXT = `# Project: demo

## Overview
${'Este projeto faz uma coisa útil e bem descrita. '.repeat(8)}

## Commands
- Test: \`npm test\`
`;

async function ctxFor(
  cwd: string,
  size: RunContext['size'],
  runner: Runner,
  task = 'tarefa',
): Promise<RunContext> {
  return {
    cwd,
    task,
    size,
    run: await createRun(cwd, task),
    config: parseConfig(''),
    runner,
  };
}

async function bigRepo(): Promise<string> {
  const cwd = await makeRepo();
  await mkdir(join(cwd, 'src'));
  for (let i = 0; i < 101; i++)
    await writeFile(
      join(cwd, 'src', `f${i}.ts`),
      `export const n${i} = ${i};\n`,
    );
  execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', 'many files'], { cwd });
  return cwd;
}

describe('recon', () => {
  it('a small repo takes one read-only explainer call and saves context.md', async () => {
    const cwd = await makeRepo();
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.canEdit).toBe(false);
    expect(fake.calls[0]?.prompt).toContain('How is this project built');
    expect(await readFile(join(ctx.run.dir, 'context.md'), 'utf-8')).toBe(
      CONTEXT,
    );
  });

  it('a large repo runs three explorers, then one explainer that receives their findings', async () => {
    const cwd = await bigRepo();
    const seen: string[] = [];
    const runner: Runner = async (req) => {
      seen.push(req.prompt);
      if (req.prompt.includes('Your Exploration Angle')) {
        // the skill body names all three angles, so look only after the angle heading
        const mine = req.prompt.slice(
          req.prompt.indexOf('Your Exploration Angle'),
        );
        const angle =
          /Structure and stack|Conventions and tooling|Runtime flow and boundaries/.exec(
            mine,
          );
        return `ACHADO:${angle?.[0]}`;
      }
      return CONTEXT;
    };
    const ctx = await ctxFor(cwd, 'complete', runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);

    expect(seen).toHaveLength(4);
    const explainer = seen.find((p) => p.includes('Explorer Findings'));
    expect(explainer).toContain('ACHADO:Structure and stack');
    expect(explainer).toContain('ACHADO:Conventions and tooling');
    expect(explainer).toContain('ACHADO:Runtime flow and boundaries');
    expect(await readFile(join(ctx.run.dir, 'context.md'), 'utf-8')).toBe(
      CONTEXT,
    );
  });

  it('asks the explainer again when the context is malformed', async () => {
    const cwd = await makeRepo();
    const fake = createFakeRunner(['curto', CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.prompt).toContain('inválida');
  });

  it('rejects an answer that apologizes before the markdown instead of saving it', async () => {
    const cwd = await makeRepo();
    const apology = `I could not write the file. The content is below.\n\n${CONTEXT}`;
    const fake = createFakeRunner([apology, CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(2);
    expect(await readFile(join(ctx.run.dir, 'context.md'), 'utf-8')).toBe(
      CONTEXT,
    );
  });

  it('saves the shared .workflow/context.md and copies it into the run folder', async () => {
    const cwd = await makeRepo();
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(await readFile(join(cwd, '.workflow', 'context.md'), 'utf-8')).toBe(
      CONTEXT,
    );
    const meta = JSON.parse(
      await readFile(join(cwd, '.workflow', 'context.json'), 'utf-8'),
    ) as { commit: string };
    expect(meta.commit).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd }).toString().trim(),
    );
  });

  it('escalates after three malformed answers', async () => {
    const cwd = await makeRepo();
    const fake = createFakeRunner(['a', 'b', 'c']);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await expect(
      createReconStage({ io: createFakeIO([]) })(ctx),
    ).rejects.toBeInstanceOf(SubagentEscalation);
  });
});

async function commitFile(
  cwd: string,
  file: string,
  message = 'change',
): Promise<void> {
  await mkdir(join(cwd, file, '..'), { recursive: true });
  await writeFile(join(cwd, file), `${Date.now()}${Math.random()}\n`);
  execFileSync('git', ['add', '-f', file], { cwd });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd });
}

/** A repo with a shared context built at the current HEAD, `daysAgo` days ago. */
async function withSharedContext(daysAgo: number): Promise<string> {
  const cwd = await makeRepo();
  const fake = createFakeRunner([CONTEXT]);
  await createReconStage({ io: createFakeIO([]) })(
    await ctxFor(cwd, 'complete', fake.runner),
  );
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  await utimes(join(cwd, '.workflow', 'context.md'), when, when);
  return cwd;
}

describe('recon reuses the shared context across runs', () => {
  it('a full run reuses it when the repo did not change', async () => {
    const cwd = await withSharedContext(2);
    const fake = createFakeRunner([]);
    const io = createFakeIO([]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io })(ctx);
    expect(fake.calls).toHaveLength(0);
    expect(await readFile(join(ctx.run.dir, 'context.md'), 'utf-8')).toBe(
      CONTEXT,
    );
    expect(io.output()).toContain('o repo não mudou');
  });

  it('a full run rebuilds it after a commit of someone else that touches code', async () => {
    const cwd = await withSharedContext(2);
    await commitFile(cwd, 'src/novo.ts');
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(1);
  });

  it("a full run keeps it after the Forge's own commits", async () => {
    const cwd = await withSharedContext(2);
    await commitFile(
      cwd,
      'src/feito.ts',
      'forge: T1 - algo\n\nForge-Run: 2026-01-01-x\nForge-Batch: 1',
    );
    const fake = createFakeRunner([]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(0);
  });

  it('a full run keeps it after a commit that only touches .workflow/', async () => {
    const cwd = await withSharedContext(2);
    await commitFile(cwd, '.workflow/lessons.md');
    const fake = createFakeRunner([]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(0);
  });

  it('rebuilds when the commit it was built from no longer exists', async () => {
    const cwd = await withSharedContext(2);
    await writeFile(
      join(cwd, '.workflow', 'context.json'),
      JSON.stringify({ commit: '0'.repeat(40) }),
    );
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(1);
  });

  it('--refresh-context rebuilds it even when nothing changed', async () => {
    const cwd = await withSharedContext(1);
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'complete', fake.runner);
    await createReconStage({ io: createFakeIO([]), refreshContext: true })(ctx);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('recon on a trivial task', () => {
  it('reuses the shared context and says how old it is, with no model call', async () => {
    const cwd = await withSharedContext(3);
    const fake = createFakeRunner([]);
    const io = createFakeIO([]);
    const ctx = await ctxFor(cwd, 'trivial', fake.runner);
    await createReconStage({ io })(ctx);
    expect(fake.calls).toHaveLength(0);
    expect(await readFile(join(ctx.run.dir, 'context.md'), 'utf-8')).toBe(
      CONTEXT,
    );
    expect(io.output()).toContain('contexto de 3 dias atrás');
  });

  it('reuses it even when the repo changed, and warns about it', async () => {
    const cwd = await withSharedContext(3);
    await commitFile(cwd, 'src/novo.ts');
    const fake = createFakeRunner([]);
    const io = createFakeIO([]);
    const ctx = await ctxFor(cwd, 'trivial', fake.runner);
    await createReconStage({ io })(ctx);
    expect(fake.calls).toHaveLength(0);
    expect(io.output()).toContain('o repo mudou');
  });

  it('builds a new one when there is no shared context yet', async () => {
    const cwd = await makeRepo();
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'trivial', fake.runner);
    await createReconStage({ io: createFakeIO([]) })(ctx);
    expect(fake.calls).toHaveLength(1);
  });

  it('--refresh-context rebuilds it even when a shared one exists', async () => {
    const cwd = await withSharedContext(1);
    const fake = createFakeRunner([CONTEXT]);
    const ctx = await ctxFor(cwd, 'trivial', fake.runner);
    await createReconStage({ io: createFakeIO([]), refreshContext: true })(ctx);
    expect(fake.calls).toHaveLength(1);
  });
});
