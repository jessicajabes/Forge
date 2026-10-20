import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { RunContext } from '../src/orchestrator.js';
import type { ProgressEvent } from '../src/progress.js';
import { createProgressReporter } from '../src/progressReporter.js';
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

  it('inserts the diff literally, without expanding $& or repeated tokens', async () => {
    const s = await setup([APPROVED]);
    await writeFile(
      join(s.ctx.cwd, 'change.txt'),
      'custo $& e o texto {LESSONS}\n',
    );
    await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(s.reviewerPrompts[0]).toContain('custo $& e o texto {LESSONS}');
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

  it('at the cycle limit, an open act_on item escalates to the human with review.md saved', async () => {
    const still = lead({ act_on: [item('Bug aberto')] });
    const s = await setup([still, still, still]);
    await expect(
      reviewBatch(s.ctx, s.batch, s.deps, s.devFix),
    ).rejects.toBeInstanceOf(ReviewEscalation);
    expect(s.feedbacks).toHaveLength(2);
    const review = await readFile(s.reviewPath, 'utf-8');
    expect(review).toContain('- **Veredito**: escalado ao humano');
    expect(review).toContain('limite de 3 ciclos');
  });

  it('at the cycle limit, only consider items left means the batch is approved and the leftovers are noted', async () => {
    const still = lead({ consider: [item('Detalhe de estilo')] });
    const s = await setup([still, still, still]);
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(3);
    expect(result.leftover.map((i) => i.title)).toEqual(['Detalhe de estilo']);
    expect(s.feedbacks).toHaveLength(2); // the Dev is not called after the last cycle
    const review = await readFile(s.reviewPath, 'utf-8');
    expect(review).toContain('- **Veredito**: aprovado');
    expect(review).toContain('Aprovado no limite de ciclos');
    expect(review).toContain('Detalhe de estilo');
  });

  it('consider items still go back to the Dev in the cycles before the limit', async () => {
    const still = lead({ consider: [item('Detalhe')] });
    const s = await setup([still, APPROVED]);
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(2);
    expect(result.leftover).toEqual([]);
    expect(s.feedbacks).toHaveLength(1);
  });

  it('respects max_review_cycles from the config', async () => {
    const still = lead({ act_on: [item('Aberto')] });
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

  it('sends an act_on item back to the Dev when the fix it claimed is kept, without escalating', async () => {
    const s = await setup([
      lead({ act_on: [item('Sem validação')] }),
      lead({
        act_on: [item('Outro')],
        previous_items: [
          {
            ref: 1,
            decision: 'maintained',
            reason: 'a correção ficou pela metade',
          },
        ],
      }),
      APPROVED,
    ]);
    const result = await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    expect(result.cycles).toBe(3);
    expect(s.feedbacks).toHaveLength(2);
    expect(s.feedbacks[1]).toContain('Sem validação'); // carried back to the Dev
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

  it('reports the reviewer and lead calls through the reporter', async () => {
    const yml =
      'steps:\n  review:\n    runner: claude-cli\n    reviewers:\n      - { runner: claude-cli, model: m-a }\n';
    const s = await setup([APPROVED], yml);
    const events: ProgressEvent[] = [];
    s.ctx.reporter = createProgressReporter({
      write: async (event) => {
        events.push(event);
      },
      stream: { write: () => undefined, isTTY: false },
      env: {},
    });
    await reviewBatch(s.ctx, s.batch, s.deps, s.devFix);
    const starts = events.filter((e) => e.type === 'call-start');
    expect(starts.map((e) => e.label)).toEqual([
      'review · reviewer-A · claude-cli/m-a',
      'review · lead · claude-cli/padrão do CLI',
    ]);
    expect(events.filter((e) => e.type === 'call-end')).toHaveLength(2);
  });

  it('escalates when the lead answers badly three times', async () => {
    const s = await setup(['lixo', 'lixo', 'lixo']);
    await expect(
      reviewBatch(s.ctx, s.batch, s.deps, s.devFix),
    ).rejects.toBeInstanceOf(SubagentEscalation);
  });
});

describe('review diff', () => {
  it('gives the reviewers only a per-file summary when the diff is over the limit', async () => {
    const t = await setup([APPROVED]);
    await writeFile(join(t.ctx.cwd, 'big.txt'), 'x'.repeat(70_000));
    await reviewBatch(t.ctx, t.batch, t.deps, t.devFix);
    const prompt = t.reviewerPrompts[0] ?? '';
    expect(prompt).toContain('over the 60000 limit');
    expect(prompt).toContain('big.txt');
    expect(prompt).not.toContain('x'.repeat(1000));
  });

  it('reads the diff against a base commit, so work already committed is still reviewed', async () => {
    const t = await setup([APPROVED, APPROVED]);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: t.ctx.cwd }).toString().trim();
    const base = git('rev-parse', 'HEAD');
    git('add', '-A');
    git('commit', '-q', '-m', 'trabalho já commitado');

    await reviewBatch(t.ctx, t.batch, t.deps, t.devFix);
    expect(t.reviewerPrompts[0]).not.toContain('change.txt');

    await reviewBatch(t.ctx, t.batch, t.deps, t.devFix, { base });
    expect(t.reviewerPrompts[1]).toContain('change.txt');
  });

  it('with groupByTask, sends one Dev call per cited task', async () => {
    const t = await setup([
      lead({
        act_on: [
          item('A', { task: 'T1' }),
          item('B', { task: 'T2' }),
          item('C', { task: 'T1' }),
          item('D', { task: null }),
        ],
      }),
      APPROVED,
    ]);
    const seen: number[][] = [];
    const devFix = async (feedback: string, taskIds: number[]) => {
      seen.push(taskIds);
      return t.devFix(feedback);
    };
    await reviewBatch(t.ctx, t.batch, t.deps, devFix, { groupByTask: true });
    expect(seen).toEqual([[1], [2], []]);
    expect(t.feedbacks[0]).toContain('1. [T1] A');
    expect(t.feedbacks[0]).toContain('2. [T1] C');
    expect(t.feedbacks[1]).toContain('1. [T2] B');
  });
});
