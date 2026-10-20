import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { RunContext } from '../src/orchestrator.js';
import type { Runner } from '../src/runner.js';
import { createRun, workflowDir } from '../src/runs.js';
import { createLessonsStage, parseSynthesis } from '../src/steps/lessons.js';
import { createFakeIO } from './fakeIO.js';
import { makeRepo } from './helpers.js';

const NOW = () => new Date('2026-10-19T12:00:00Z');
const CANDIDATE =
  '- RULE: Toda rota nova precisa de teste de erro\n  EVIDENCE: review.md, ciclo 1\n  TASK: T1\n  WHY IT LASTS: aparece em toda rota';
const NONE = 'No candidates.';
const synth = (rules: string[]) =>
  JSON.stringify({
    accepted: rules.map((rule) => ({
      rule,
      task: 'T1',
      evidence: 'review.md',
      lenses: ['judgment'],
    })),
    rejected: [],
  });

async function setup(responder: (prompt: string) => string, yml = '') {
  const cwd = await makeRepo();
  const run = await createRun(cwd, 'lições');
  await writeFile(
    join(run.dir, 'review.md'),
    '# Revisão\n\nciclo com problema de rota sem teste\n',
  );
  await writeFile(
    join(run.dir, 'tasks.md'),
    '# Tarefas\n\nTEXTO-DAS-TAREFAS\n',
  );
  await writeFile(join(run.dir, 'spec.md'), '# Spec\n\nTEXTO-DO-SPEC\n');
  const prompts: string[] = [];
  const runner: Runner = async (req) => {
    prompts.push(req.prompt);
    return responder(req.prompt);
  };
  const ctx: RunContext = {
    cwd,
    task: 'lições',
    size: 'complete',
    run,
    config: parseConfig(yml),
    runner,
  };
  const file = join(workflowDir(cwd), 'lessons.md');
  return { ctx, prompts, file };
}

const lensOrSynth = (synthesis: string) => (p: string) =>
  p.includes('synthesizer of the Lessons') ? synthesis : CANDIDATE;

describe('parseSynthesis', () => {
  it('accepts the JSON and defaults the lists', () => {
    expect(
      parseSynthesis('{"accepted":[{"rule":"r"}]}').accepted[0]?.task,
    ).toBeNull();
    expect(() => parseSynthesis('x')).toThrow(/JSON/);
  });
});

describe('lessons stage', () => {
  it('writes an approved lesson in the lessons.md format', async () => {
    const s = await setup(
      lensOrSynth(synth(['Toda rota nova precisa de teste de erro'])),
    );
    await createLessonsStage({ io: createFakeIO(['sim']), now: NOW })(s.ctx);
    expect(await readFile(s.file, 'utf-8')).toBe(
      '- Toda rota nova precisa de teste de erro (2026-10-19, T1)\n',
    );
  });

  it('writes nothing without approval: "não" and an empty answer both skip', async () => {
    const s = await setup(lensOrSynth(synth(['Regra A', 'Regra B'])));
    await createLessonsStage({ io: createFakeIO(['não', '']), now: NOW })(
      s.ctx,
    );
    await expect(readFile(s.file, 'utf-8')).rejects.toThrow();
  });

  it('"editar" asks for a new wording and writes that one', async () => {
    const s = await setup(lensOrSynth(synth(['Regra original'])));
    await createLessonsStage({
      io: createFakeIO(['editar', 'Regra reescrita']),
      now: NOW,
    })(s.ctx);
    const text = await readFile(s.file, 'utf-8');
    expect(text).toContain('Regra reescrita');
    expect(text).not.toContain('Regra original');
  });

  it('approves one by one, keeping the existing lessons', async () => {
    const s = await setup(lensOrSynth(synth(['Regra A', 'Regra B'])));
    await writeFile(
      join(workflowDir(s.ctx.cwd), 'lessons.md'),
      '- Regra antiga (2026-10-01, T9)\n',
    ).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(workflowDir(s.ctx.cwd), { recursive: true });
      await writeFile(s.file, '- Regra antiga (2026-10-01, T9)\n');
    });
    await createLessonsStage({ io: createFakeIO(['sim', 'não']), now: NOW })(
      s.ctx,
    );
    const text = await readFile(s.file, 'utf-8');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- Regra antiga (2026-10-01, T9)',
      '- Regra A (2026-10-19, T1)',
    ]);
  });

  it('at the limit it shows the old lessons and removes the ones the person picks', async () => {
    const s = await setup(lensOrSynth(synth(['Regra nova'])), 'max_lessons: 2');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workflowDir(s.ctx.cwd), { recursive: true });
    await writeFile(
      s.file,
      '- Antiga um (2026-10-01, T1)\n- Antiga dois (2026-10-02, T2)\n',
    );
    const io = createFakeIO(['sim', '1']);
    await createLessonsStage({ io, now: NOW })(s.ctx);
    expect(io.output()).toContain('limite de 2 lições');
    expect(io.output()).toContain('1. Antiga um');
    const text = await readFile(s.file, 'utf-8');
    expect(text).not.toContain('Antiga um');
    expect(text).toContain('Antiga dois');
    expect(text).toContain('Regra nova');
  });

  it('at the limit, an empty answer keeps everything and drops the new lesson', async () => {
    const s = await setup(lensOrSynth(synth(['Regra nova'])), 'max_lessons: 1');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workflowDir(s.ctx.cwd), { recursive: true });
    await writeFile(s.file, '- Antiga (2026-10-01, T1)\n');
    await createLessonsStage({ io: createFakeIO(['sim', '']), now: NOW })(
      s.ctx,
    );
    expect(await readFile(s.file, 'utf-8')).toBe('- Antiga (2026-10-01, T1)\n');
  });

  it('says so and calls no synthesizer when no lens finds a candidate', async () => {
    const s = await setup(() => NONE);
    const io = createFakeIO([]);
    await createLessonsStage({ io, now: NOW })(s.ctx);
    expect(io.output()).toContain('Nenhuma lição nova');
    expect(s.prompts).toHaveLength(3);
  });

  it('gives each lens only its slice of the run', async () => {
    const s = await setup(lensOrSynth(synth([])));
    await createLessonsStage({ io: createFakeIO([]), now: NOW })(s.ctx);
    const by = (name: string) =>
      s.prompts.find((p) => p.includes(`You are the **${name}** lens`)) ?? '';
    expect(by('judgment')).toContain('TEXTO-DAS-TAREFAS');
    expect(by('judgment')).toContain('TEXTO-DO-SPEC');
    expect(by('tooling')).not.toContain('TEXTO-DAS-TAREFAS');
    expect(by('tooling')).not.toContain('TEXTO-DO-SPEC');
    expect(by('divergent')).toContain('TEXTO-DO-SPEC');
    expect(by('divergent')).not.toContain('TEXTO-DAS-TAREFAS');
  });

  it('skips the lessons without failing the run when a lens keeps answering badly', async () => {
    const s = await setup(() => 'resposta sem formato');
    const io = createFakeIO([]);
    await createLessonsStage({ io, now: NOW })(s.ctx);
    expect(io.output()).toContain('As lições ficaram de fora');
  });
});
