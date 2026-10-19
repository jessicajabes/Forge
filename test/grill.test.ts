import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { IO } from '../src/io.js';
import type { RunContext } from '../src/orchestrator.js';
import { createRun } from '../src/runs.js';
import { createGrillStage, parseMove } from '../src/steps/grill.js';
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
const spec = (open = 'nenhum') => `# Spec: Login

## Objetivo
Entrar com Google.

## Decisões
- Usar OAuth

## Fora do escopo
- nenhum

## Restrições
- nenhuma

## Pontos em aberto
- ${open}
`;

async function setup(responses: string[], answers: string[]) {
  const cwd = await makeRepo();
  const run = await createRun(cwd, 'login');
  const fake = createFakeRunner(responses);
  const io = createFakeIO(answers);
  const ctx: RunContext = {
    cwd,
    task: 'adicionar login',
    size: 'complete',
    run,
    config: parseConfig(''),
    runner: fake.runner,
  };
  return { ctx, fake, io, specPath: join(run.dir, 'spec.md') };
}

describe('parseMove', () => {
  it('accepts JSON inside a code fence and rejects the rest', () => {
    expect(parseMove('```json\n{"action":"ready"}\n```').action).toBe('ready');
    expect(() => parseMove('sem json')).toThrow(/JSON/);
    expect(() => parseMove('{"action":"question"}')).toThrow();
  });
});

describe('grill', () => {
  it('asks one question at a time, with the recommendation, and saves the spec only after confirmation', async () => {
    const { ctx, fake, io, specPath } = await setup(
      [q('Banco'), READY, spec()],
      ['sim', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(io.output()).toContain('Q1 - Banco');
    expect(io.output()).toContain('Recomendado: Rec Banco');
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.every((c) => !c.canEdit)).toBe(true);
    expect(fake.calls[1]?.prompt).toContain('accepted the recommended answer');
    expect(await readFile(specPath, 'utf-8')).toBe(spec());
  });

  it('does not write spec.md before the person confirms', async () => {
    const { ctx, io: base, specPath } = await setup([READY, spec()], ['sim']);
    const io: IO = {
      ...base,
      ask: async (question) => {
        if (question.startsWith('Confirma'))
          expect(existsSync(specPath)).toBe(false);
        return base.ask(question);
      },
    };
    await createGrillStage({ io })(ctx);
    expect(existsSync(specPath)).toBe(true);
  });

  it('"chega" ends the interview: the question on screen becomes an open point', async () => {
    const { ctx, fake, io, specPath } = await setup(
      [q('Banco'), spec('Banco: Corpo de Banco?')],
      ['chega', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(fake.calls[1]?.prompt).toContain('got no answer');
    expect(fake.calls[1]?.prompt).toContain('Banco: Corpo de Banco?');
    expect(io.output()).toContain('pontos em aberto');
    expect(existsSync(specPath)).toBe(true);
  });

  it('"depois" is the only way to make an open point', async () => {
    const { ctx, fake, io } = await setup(
      [q('A'), q('B'), READY, spec()],
      ['depois', 'sim', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(fake.calls[1]?.prompt).toContain('postponed. This is an open point');
    expect(fake.calls[2]?.prompt).toContain('Q2 - B');
  });

  it('"não sei" asks for help once, then follows the recommendation as provisional', async () => {
    const help = JSON.stringify({
      action: 'help',
      text: 'Alternativas: X ou Y.',
    });
    const { ctx, fake, io } = await setup(
      [q('A'), help, READY, spec()],
      ['não sei', 'não sei', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(io.output()).toContain('Alternativas: X ou Y.');
    expect(io.output()).toContain('provisória');
    expect(fake.calls[1]?.prompt).toContain('does not know how to answer Q1');
    expect(fake.calls[2]?.prompt).toContain('(provisória)');
  });

  it('"voltar" drops the question on screen and asks the last answered one again', async () => {
    const { ctx, fake, io } = await setup(
      [q('A'), q('B'), READY, spec()],
      ['minha resposta', 'voltar', 'sim', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(io.output().match(/Q1 - A/g)).toHaveLength(2);
    expect(io.output().match(/Q2 - B/g)).toHaveLength(1);
    const lastNext = fake.calls[2]?.prompt ?? '';
    expect(lastNext).toContain('accepted the recommended answer');
    expect(lastNext).not.toContain('answered: minha resposta');
    expect(lastNext).not.toContain('Q2 - B');
  });

  it('"voltar" with nothing to undo says so and keeps the question', async () => {
    const { ctx, io } = await setup(
      [q('A'), READY, spec()],
      ['voltar', 'sim', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(io.output()).toContain('Não há resposta anterior');
  });

  it('rejecting the summary turns the correction into a decision and goes back to the interview', async () => {
    const { ctx, fake, io, specPath } = await setup(
      [READY, spec(), READY, spec()],
      ['falta definir o logout', 'sim'],
    );
    await createGrillStage({ io })(ctx);
    expect(fake.calls[2]?.prompt).toContain(
      'Correction from the user after reading the summary: falta definir o logout',
    );
    expect(await readFile(specPath, 'utf-8')).toBe(spec());
    expect(fake.calls).toHaveLength(4);
  });

  it('asks the model again after a malformed reply, and escalates on the third', async () => {
    const ok = await setup(['lixo', READY, spec()], ['sim']);
    await createGrillStage({ io: ok.io })(ok.ctx);
    expect(ok.fake.calls).toHaveLength(3);

    const bad = await setup(['x', 'y', 'z'], []);
    await expect(
      createGrillStage({ io: bad.io })(bad.ctx),
    ).rejects.toBeInstanceOf(SubagentEscalation);
  });

  it('reports progress after every change so a draft can be saved', async () => {
    const { ctx, io } = await setup([q('A'), READY, spec()], ['sim', 'sim']);
    const seen: number[] = [];
    await createGrillStage({
      io,
      onProgress: (s) => void seen.push(s.turns.length),
    })(ctx);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...seen)).toBe(1);
  });
});
