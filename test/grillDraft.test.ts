import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { IO } from '../src/io.js';
import type { RunContext } from '../src/orchestrator.js';
import { createRun } from '../src/runs.js';
import { createGrillStage, loadDraft } from '../src/steps/grill.js';
import { SubagentEscalation } from '../src/subagents.js';
import { createFakeIO } from './fakeIO.js';
import { createFakeRunner } from './fakeRunner.js';
import { makeRepo } from './helpers.js';

const q = (title: string) =>
  JSON.stringify({
    action: 'question',
    title,
    body: `Corpo de ${title}?`,
    recommended: `Rec ${title}`,
  });
const READY = JSON.stringify({ action: 'ready' });
const SPEC = `# Spec: Login

## Objetivo
Entrar.

## Decisões
- Usar OAuth

## Fora do escopo
- nenhum

## Restrições
- nenhuma

## Pontos em aberto
- nenhum
`;

async function setup(responses: string[]) {
  const cwd = await makeRepo();
  const run = await createRun(cwd, 'login');
  const fake = createFakeRunner(responses);
  const ctx: RunContext = {
    cwd,
    task: 'login',
    size: 'complete',
    run,
    config: parseConfig(''),
    runner: fake.runner,
  };
  return { ctx, fake, draft: join(run.dir, 'grill-draft.json') };
}

/** An IO that behaves like Ctrl+C on a given question. */
function interrupt(base: IO, onQuestionNumber: number): IO {
  let asked = 0;
  return {
    ...base,
    ask: async (question) => {
      if (question === '> ' && ++asked === onQuestionNumber)
        throw new Error('SIGINT');
      return base.ask(question);
    },
  };
}

describe('grill draft', () => {
  it('Ctrl+C keeps a draft with the answers and the question that was on screen', async () => {
    const { ctx, draft } = await setup([q('A'), q('B')]);
    const io = interrupt(createFakeIO(['sim']), 2);
    await expect(createGrillStage({ io })(ctx)).rejects.toThrow('SIGINT');
    const saved = await loadDraft(ctx.run.dir);
    expect(saved?.turns).toHaveLength(1);
    expect(saved?.pending?.title).toBe('B');
    expect(existsSync(draft)).toBe(true);
  });

  it('continuing the draft asks the pending question again without calling the model', async () => {
    const { ctx, draft } = await setup([q('A'), q('B')]);
    await expect(
      createGrillStage({ io: interrupt(createFakeIO(['sim']), 2) })(ctx),
    ).rejects.toThrow();

    const second = createFakeRunner([READY, SPEC]);
    const io = createFakeIO(['c', 'sim', 'sim']);
    await createGrillStage({ io })({ ...ctx, runner: second.runner });
    expect(io.output()).toContain('Q2 - B');
    expect(second.calls).toHaveLength(2);
    expect(second.calls[0]?.prompt).toContain('Q1 - A');
    expect(existsSync(draft)).toBe(false);
  });

  it('starting over deletes the draft and begins with an empty interview', async () => {
    const { ctx } = await setup([q('A'), q('B')]);
    await expect(
      createGrillStage({ io: interrupt(createFakeIO(['sim']), 2) })(ctx),
    ).rejects.toThrow();

    const second = createFakeRunner([READY, SPEC]);
    const io = createFakeIO(['r', 'sim']);
    await createGrillStage({ io })({ ...ctx, runner: second.runner });
    expect(second.calls[0]?.prompt).toContain('(nothing decided yet)');
  });

  it('deletes the draft once spec.md is written', async () => {
    const { ctx, draft } = await setup([q('A'), READY, SPEC]);
    await createGrillStage({ io: createFakeIO(['sim', 'sim']) })(ctx);
    expect(existsSync(join(ctx.run.dir, 'spec.md'))).toBe(true);
    expect(existsSync(draft)).toBe(false);
  });

  it('an escalation after three malformed replies keeps the progress in the draft', async () => {
    const { ctx } = await setup([q('A'), 'x', 'y', 'z']);
    await expect(
      createGrillStage({ io: createFakeIO(['sim']) })(ctx),
    ).rejects.toBeInstanceOf(SubagentEscalation);
    const saved = await loadDraft(ctx.run.dir);
    expect(saved?.turns).toHaveLength(1);
  });

  it('ignores a corrupt draft instead of crashing', async () => {
    const { ctx, draft } = await setup([READY, SPEC]);
    await writeFile(draft, '{ não é json');
    await createGrillStage({ io: createFakeIO(['sim']) })(ctx);
    expect(await readFile(join(ctx.run.dir, 'spec.md'), 'utf-8')).toBe(SPEC);
  });
});
