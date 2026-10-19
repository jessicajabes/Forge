import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpec } from '../src/artifacts.js';
import { parseConfig } from '../src/config.js';
import type { RunContext } from '../src/orchestrator.js';
import { createRun, workflowDir } from '../src/runs.js';
import { createTasksStage } from '../src/steps/tasks.js';
import { SubagentEscalation } from '../src/subagents.js';
import { createFakeRunner } from './fakeRunner.js';
import { makeRepo } from './helpers.js';

const SPEC = `# Spec: Login

## Objetivo
Entrar com Google.

## Decisões
- Usar OAuth

## Fora do escopo
- nenhum

## Restrições
- nenhuma

## Pontos em aberto
- nenhum
`;
const PROVISIONAL_SPEC = SPEC.replace(
  '- Usar OAuth',
  '- Corrigir o typo (provisória)',
);
const TASKS = `# Tarefas

## T1: Rota
- **Arquivos**: src/a.ts
- **O que fazer**: Algo.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const CONTEXT = '# Project: demo\n\n## Overview\nContexto do projeto demo.\n';

async function setup(
  size: RunContext['size'],
  responses: string[],
  files: Record<string, string> = {},
) {
  const cwd = await makeRepo();
  const run = await createRun(cwd, 'tarefa');
  const fake = createFakeRunner(responses);
  const ctx: RunContext = {
    cwd,
    task: 'corrigir o typo no README',
    size,
    run,
    config: parseConfig(''),
    runner: fake.runner,
  };
  for (const [name, text] of Object.entries(files))
    await writeFile(join(run.dir, name), text);
  return { ctx, fake };
}

describe('tasks stage', () => {
  it('writes a valid tasks.md from spec and context, in one read-only call', async () => {
    const { ctx, fake } = await setup('complete', [TASKS], {
      'spec.md': SPEC,
      'context.md': CONTEXT,
    });
    await createTasksStage()(ctx);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.canEdit).toBe(false);
    expect(fake.calls[0]?.prompt).toContain('Usar OAuth');
    expect(fake.calls[0]?.prompt).toContain('Contexto do projeto demo');
    expect(await readFile(join(ctx.run.dir, 'tasks.md'), 'utf-8')).toBe(TASKS);
  });

  it('asks again when tasks.md is malformed and escalates after three failures', async () => {
    const retry = await setup('complete', ['lixo', TASKS], {
      'spec.md': SPEC,
      'context.md': CONTEXT,
    });
    await createTasksStage()(retry.ctx);
    expect(retry.fake.calls).toHaveLength(2);
    expect(retry.fake.calls[1]?.prompt).toContain('inválida');

    const bad = await setup('complete', ['a', 'b', 'c'], {
      'spec.md': SPEC,
      'context.md': CONTEXT,
    });
    await expect(createTasksStage()(bad.ctx)).rejects.toBeInstanceOf(
      SubagentEscalation,
    );
  });

  it('passes lessons.md to the stage only when it exists', async () => {
    const without = await setup('complete', [TASKS], {
      'spec.md': SPEC,
      'context.md': CONTEXT,
    });
    await createTasksStage()(without.ctx);
    expect(without.fake.calls[0]?.prompt).not.toContain('lessons.md\n');

    const withLessons = await setup('complete', [TASKS], {
      'spec.md': SPEC,
      'context.md': CONTEXT,
    });
    await writeFile(
      join(workflowDir(withLessons.ctx.cwd), 'lessons.md'),
      '- Toda rota nova tem teste de erro (2026-10-18, T3)\n',
    );
    await createTasksStage()(withLessons.ctx);
    expect(withLessons.fake.calls[0]?.prompt).toContain('## lessons.md');
    expect(withLessons.fake.calls[0]?.prompt).toContain('teste de erro');
  });
});

describe('tasks stage on a trivial task', () => {
  it('writes a minimal spec with every decision provisional, then the tasks', async () => {
    const { ctx, fake } = await setup('trivial', [PROVISIONAL_SPEC, TASKS], {
      'context.md': CONTEXT,
    });
    await createTasksStage()(ctx);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.prompt).toContain('corrigir o typo no README');
    const spec = parseSpec(
      await readFile(join(ctx.run.dir, 'spec.md'), 'utf-8'),
    );
    expect(spec.decisions.every((d) => d.provisional)).toBe(true);
    expect(fake.calls[1]?.prompt).toContain('(provisória)');
  });

  it('rejects a minimal spec that has a decision not marked provisional', async () => {
    const { ctx, fake } = await setup(
      'trivial',
      [SPEC, PROVISIONAL_SPEC, TASKS],
      { 'context.md': CONTEXT },
    );
    await createTasksStage()(ctx);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.prompt).toContain('inválida');
  });
});
