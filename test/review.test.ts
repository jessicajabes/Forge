import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { RunContext } from '../src/orchestrator.js';
import type { Runner, RunnerFactory } from '../src/runner.js';
import { createRun, ensureLocalExclude } from '../src/runs.js';
import { SubagentEscalation } from '../src/subagents.js';
import { splitBatches } from '../src/steps/dev.js';
import {
  ReviewEscalation,
  computeVerdict,
  parseDevAnswers,
  parseLead,
  reviewBatch,
} from '../src/steps/review.js';
import { parseTasks } from '../src/artifacts.js';
import { createFakeIO } from './fakeIO.js';
import { makeRepo } from './helpers.js';

const TASKS = `# Tarefas

## T1: Rota
- **Arquivos**: src/a.ts
- **O que fazer**: Fazer.
- **Critério de aceite**:
  - [ ] \`npm test\` passa
- **Depende de**: nenhuma
`;
const item = (title: string, extra: object = {}) => ({
  task: 'T1',
  title,
  description: `${title} está errado`,
  raised_by: ['A'],
  rationale: 'importa',
  ...extra,
});
const lead = (o: {
  act_on?: object[];
  consider?: object[];
  noted?: object[];
  dismissed?: object[];
  previous_items?: object[];
  verdict?: string;
}) =>
  JSON.stringify({
    verdict: 'rejected',
    act_on: [],
    consider: [],
    noted: [],
    dismissed: [],
    previous_items: [],
    ...o,
  });
const APPROVED = lead({ verdict: 'approved' });

async function setup(leads: string[], yml = '') {
  const cwd = await makeRepo();
  await ensureLocalExclude(cwd);
  const run = await createRun(cwd, 'revisão');
  await writeFile(join(run.dir, 'tasks.md'), TASKS);
  await writeFile(
    join(run.dir, 'spec.md'),
    '# Spec: x\n\n## Objetivo\nFazer a rota.\n\n## Decisões\n- a\n\n## Fora do escopo\n- nenhum\n\n## Restrições\n- nenhuma\n\n## Pontos em aberto\n- nenhum\n',
  );
  const reviewerPrompts: string[] = [];
  const leadPrompts: string[] = [];
  const reviewerModels: (string | undefined)[] = [];
  let leadCall = 0;
  const makeRunner: RunnerFactory = (o) => async (req) => {
    if (req.prompt.includes('adversarial code reviewer')) {
      reviewerPrompts.push(req.prompt);
      reviewerModels.push(o.model);
      return `## Findings\n\nachado do ${o.model ?? 'padrão'}`;
    }
    leadPrompts.push(req.prompt);
    const next = leads[leadCall++];
    if (next === undefined) throw new Error('líder sem resposta roteirizada');
    return next;
  };
  const feedbacks: string[] = [];
  let devCalls = 0;
  const devFix = async (feedback: string) => {
    feedbacks.push(feedback);
    devCalls++;
    await writeFile(join(cwd, `fix-${devCalls}.txt`), 'x');
    return feedback
      .split('\n')
      .filter((l) => /^\d+\./.test(l))
      .map((l, i) => `${i + 1}. Corrigido: ok`)
      .join('\n');
  };
  const runner: Runner = async () => '';
  const ctx: RunContext = {
    cwd,
    task: 'revisão',
    size: 'complete',
    run,
    config: parseConfig(yml),
    runner,
  };
  await writeFile(join(cwd, 'change.txt'), 'mudança em revisão\n');
  const batch = splitBatches(parseTasks(TASKS).tasks, 'final')[0]!;
  const deps = { makeRunner, io: createFakeIO([]) };
  return {
    ctx,
    batch,
    deps,
    devFix,
    feedbacks,
    reviewerPrompts,
    leadPrompts,
    reviewerModels,
    reviewPath: join(run.dir, 'review-batch-1.md'),
  };
}

describe('parsers', () => {
  it('parseLead accepts the JSON of the skill, with omitted lists, inside a fence', () => {
    const v = parseLead('```json\n{"verdict":"approved"}\n```');
    expect(v.act_on).toEqual([]);
    expect(() => parseLead('nada')).toThrow(/JSON/);
  });

  it('computeVerdict rejects on act_on, consider or a maintained item, and approves otherwise', () => {
    const base = parseLead(APPROVED);
    expect(computeVerdict(base)).toBe('approved');
    expect(computeVerdict({ ...base, act_on: [item('x')] as never })).toBe(
      'rejected',
    );
    expect(computeVerdict({ ...base, consider: [item('x')] as never })).toBe(
      'rejected',
    );
    expect(
      computeVerdict({
        ...base,
        noted: [item('x')] as never,
        dismissed: [item('y')] as never,
      }),
    ).toBe('approved');
    expect(
      computeVerdict({
        ...base,
        previous_items: [{ ref: 1, decision: 'maintained', reason: 'r' }],
      }),
    ).toBe('rejected');
  });

  it('parseDevAnswers reads fixed and not-fixed lines and fills the gaps', () => {
    const answers = parseDevAnswers(
      'Feito.\n1. Corrigido: validei\n2. Não corrigido: já é validado antes\n',
      3,
    );
    expect(answers[0]).toEqual({ fixed: true, text: 'validei' });
    expect(answers[1]).toEqual({ fixed: false, text: 'já é validado antes' });
    expect(answers[2]?.fixed).toBe(false);
    expect(answers[2]?.text).toContain('sem resposta');
  });
});

describe('reviewBatch', () => {
  it('approves in one cycle when nothing is wrong, without calling the Dev', async () => {
    const s = await setup([APPROVED]);
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(1);
    expect(s.feedbacks).toEqual([]);
    expect(s.leadPrompts[0]).toContain('Fazer a rota.');
    expect(s.leadPrompts[0]).toContain('mudança em revisão');
    expect(await readFile(s.reviewPath, 'utf-8')).toContain(
      '- **Veredito**: aprovado',
    );
  });

  it('rejects, sends the numbered items to the Dev, and approves in the next cycle', async () => {
    const s = await setup([
      lead({ act_on: [item('Sem validação')], consider: [item('Nome ruim')] }),
      APPROVED,
    ]);
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(2);
    expect(s.feedbacks).toHaveLength(1);
    expect(s.feedbacks[0]).toContain('1. [T1] Sem validação');
    expect(s.feedbacks[0]).toContain('2. [T1] Nome ruim');
    expect(s.feedbacks[0]).toContain('Corrigido');
    const review = await readFile(s.reviewPath, 'utf-8');
    expect(review).toContain('## Ciclo 1: reprovado');
    expect(review).toContain('1. Corrigido: ok');
    expect(review).toContain('## Ciclo 2: aprovado');
    expect(review).toContain('- **Ciclos realizados**: 2 de 3');
  });

  it('shows the second cycle the Dev answers to the first', async () => {
    const s = await setup([
      lead({ act_on: [item('Sem validação')] }),
      APPROVED,
    ]);
    await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(s.leadPrompts[1]).toContain('Previous cycle');
    expect(s.leadPrompts[1]).toContain('Dev: fixed - ok');
    expect(s.reviewerPrompts[1]).toContain('Sem validação');
  });

  it('noted and dismissed items are recorded but never go back to the Dev', async () => {
    const s = await setup([
      lead({
        verdict: 'approved',
        noted: [item('Otimização futura')],
        dismissed: [item('Falso alarme', { rationale: 'já validado' })],
      }),
    ]);
    await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(s.feedbacks).toEqual([]);
    const review = await readFile(s.reviewPath, 'utf-8');
    expect(review).toContain('- Anotado: [T1] Otimização futura');
    expect(review).toContain('- Descartado: [T1] Falso alarme');
  });

  it('trusts the code over the lead when the verdict disagrees with the items', async () => {
    const s = await setup([
      lead({ verdict: 'approved', act_on: [item('Bug')] }),
      APPROVED,
    ]);
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(2);
    expect(s.deps.io.output()).toContain('Vale o cálculo do Forge');
  });

  it('stops at the cycle limit and escalates with review.md saved', async () => {
    const still = lead({ consider: [item('Ainda aberto')] });
    const s = await setup([still, still, still]);
    await expect(
      reviewBatch(s.ctx, s.batch, s.deps, s.devFix),
    ).rejects.toBeInstanceOf(ReviewEscalation);
    expect(s.feedbacks).toHaveLength(2);
    const review = await readFile(s.reviewPath, 'utf-8');
    expect(review).toContain('- **Veredito**: escalado ao humano');
    expect(review).toContain('limite de 3 ciclos');
  });

  it('respects max_review_cycles from the config', async () => {
    const still = lead({ consider: [item('Aberto')] });
    const s = await setup([still, still], 'max_review_cycles: 2');
    await expect(reviewBatch(s.ctx, s.batch, s.deps, s.devFix)).rejects.toThrow(
      /limite de 2 ciclos/,
    );
  });

  it('escalates straight to the human when an act_on item is kept after the justification', async () => {
    const s = await setup([
      lead({ act_on: [item('Sem validação')] }),
      lead({
        act_on: [item('Sem validação')],
        previous_items: [
          {
            ref: 1,
            decision: 'maintained',
            reason: 'a justificativa não responde',
          },
        ],
      }),
      APPROVED,
    ]);
    s.devFix = async (feedback) => {
      s.feedbacks.push(feedback);
      return '1. Não corrigido: já é validado no gateway';
    };
    await expect(reviewBatch(s.ctx, s.batch, s.deps, s.devFix)).rejects.toThrow(
      /manteve um item act_on/,
    );
    expect(s.feedbacks).toHaveLength(1); // the third cycle never ran
    const review = await readFile(s.reviewPath, 'utf-8');
    expect(review).toContain('1. Não corrigido: já é validado no gateway');
    expect(review).toContain('Motivo da escalada');
  });

  it('closes a consider item the Dev justified, and approves', async () => {
    const s = await setup([
      lead({ consider: [item('Nome ruim')] }),
      lead({
        verdict: 'approved',
        previous_items: [
          { ref: 1, decision: 'closed', reason: 'a justificativa vale' },
        ],
      }),
    ]);
    s.devFix = async () => '1. Não corrigido: o nome segue o padrão do módulo';
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(2);
  });

  it('uses one reviewer per configured model, in parallel', async () => {
    const yml =
      'steps:\n  review:\n    runner: claude-cli\n    reviewers:\n      - { runner: claude-cli, model: m-a }\n      - { runner: copilot-cli, model: m-b }\n';
    const s = await setup([APPROVED], yml);
    await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(s.reviewerModels.sort()).toEqual(['m-a', 'm-b']);
    expect(s.leadPrompts[0]).toContain('Reviewer A (m-a)');
    expect(s.leadPrompts[0]).toContain('Reviewer B (m-b)');
  });

  it('escalates when the lead answers badly three times', async () => {
    const s = await setup(['lixo', 'lixo', 'lixo']);
    await expect(
      reviewBatch(s.ctx, s.batch, s.deps, s.devFix),
    ).rejects.toBeInstanceOf(SubagentEscalation);
  });
});
