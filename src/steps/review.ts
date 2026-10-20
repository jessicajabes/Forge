import { join } from 'node:path';
import { z } from 'zod';
import { parseSpec, saveArtifact } from '../artifacts.js';
import { workingDiff, workingDiffStat } from '../git.js';
import type { IO } from '../io.js';
import type { RunContext } from '../orchestrator.js';
import type { RunnerFactory } from '../runner.js';
import { readReference, loadSkill } from '../skills.js';
import { assertAllOk, runSubagents } from '../subagents.js';
import { gatherInputs, type Batch } from './dev.js';

// ---------- what the lead returns (skills/review) ----------

const itemSchema = z.object({
  task: z.string().nullable().default(null),
  title: z.string(),
  description: z.string(),
  raised_by: z.array(z.string()).default([]),
  rationale: z.string().default(''),
  suggestion: z.string().optional(),
});
export type Item = z.infer<typeof itemSchema>;

const leadSchema = z.object({
  verdict: z.enum(['approved', 'rejected']),
  reviewers: z
    .array(
      z.object({ label: z.string(), model: z.string(), findings: z.number() }),
    )
    .default([]),
  act_on: z.array(itemSchema).default([]),
  consider: z.array(itemSchema).default([]),
  noted: z.array(itemSchema).default([]),
  dismissed: z.array(itemSchema).default([]),
  previous_items: z
    .array(
      z.object({
        ref: z.number().int(),
        decision: z.enum(['closed', 'maintained']),
        reason: z.string().default(''),
      }),
    )
    .default([]),
  agreement_map: z.string().default(''),
});
export type LeadVerdict = z.infer<typeof leadSchema>;

export function parseLead(text: string): LeadVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start)
    throw new Error('a resposta do líder não tem JSON');
  return leadSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** The rule of DESIGN 6.1, applied in code so a wrong verdict from the model cannot pass. */
export function computeVerdict(lead: LeadVerdict): 'approved' | 'rejected' {
  const blocked =
    lead.act_on.length > 0 ||
    lead.consider.length > 0 ||
    lead.previous_items.some((p) => p.decision === 'maintained');
  return blocked ? 'rejected' : 'approved';
}

// ---------- the Dev's answers ----------

export type DevAnswer = { fixed: boolean; text: string };

/** Reads `N. Corrigido: ...` / `N. Não corrigido: ...` lines from the Dev's report. */
export function parseDevAnswers(report: string, count: number): DevAnswer[] {
  const answers: DevAnswer[] = Array.from({ length: count }, () => ({
    fixed: false,
    text: '(sem resposta do Dev)',
  }));
  for (const line of report.split('\n')) {
    const m =
      /^\s*(?:[-*]\s*)?(\d+)[.)]\s*(corrigido|n[aã]o corrigido)\b[:\s-]*(.*)$/i.exec(
        line,
      );
    if (!m) continue;
    const index = Number(m[1]) - 1;
    if (index < 0 || index >= count) continue;
    answers[index] = {
      fixed: !/^n/i.test(m[2] ?? ''),
      text: (m[3] ?? '').trim(),
    };
  }
  return answers;
}

// ---------- the loop ----------

type SentItem = Item & { bucket: 'act_on' | 'consider' };
type Cycle = {
  number: number;
  verdict: 'approved' | 'rejected';
  sent: SentItem[];
  answers: DevAnswer[];
  noted: Item[];
  dismissed: Item[];
  previous: LeadVerdict['previous_items'];
  /** Reviewer label to model name, as the lead reported it. */
  models: Record<string, string>;
};

export class ReviewEscalation extends Error {
  constructor(
    message: string,
    public readonly reviewPath: string,
  ) {
    super(message);
    this.name = 'ReviewEscalation';
  }
}

export type ReviewDeps = {
  /** Read-only runners for the reviewers and the lead. */
  makeRunner: RunnerFactory;
  io: IO;
  skillsDir?: string;
};

const label = (i: number) => String.fromCharCode(65 + i);
const line = (i: Item) =>
  `${i.task ? `[${i.task}] ` : ''}${i.title}: ${i.description}`;

function renderReview(
  cycles: Cycle[],
  status: 'approved' | 'escalated',
  max: number,
  reason?: string,
  /** `consider` items still open when the cycle limit approved the batch. */
  leftover: Item[] = [],
): string {
  const atLimit =
    leftover.length > 0
      ? `\n- **Aprovado no limite de ciclos**: ${leftover.length} ${leftover.length === 1 ? 'item' : 'itens'} \`consider\` ficaram em aberto e foram anotados, sem voltar ao Dev: ${leftover.map((i) => i.title).join('; ')}`
      : '';
  const head = `# Revisão

## Resumo
- **Veredito**: ${status === 'approved' ? 'aprovado' : 'escalado ao humano'}
- **Ciclos realizados**: ${cycles.length} de ${max}${atLimit}${reason ? `\n- **Motivo da escalada**: ${reason}` : ''}
`;
  const blocks = cycles.map((c) => {
    const sent =
      c.sent.length > 0
        ? c.sent.map((s, i) => `${i + 1}. ${line(s)}`).join('\n')
        : '(nenhum)';
    const answers =
      c.answers.length > 0
        ? c.answers
            .map(
              (a, i) =>
                `${i + 1}. ${a.fixed ? 'Corrigido' : 'Não corrigido'}: ${a.text}`,
            )
            .join('\n')
        : '(o Dev não foi chamado neste ciclo)';
    const previous =
      c.previous.length > 0
        ? `\n### Itens do ciclo anterior\n${c.previous.map((p) => `- Item ${p.ref}: ${p.decision === 'closed' ? 'encerrado' : 'mantido'} (${p.reason})`).join('\n')}\n`
        : '';
    const notes = [
      ...c.noted.map((n) => `- Anotado: ${line(n)}`),
      ...c.dismissed.map((d) => `- Descartado: ${line(d)} (${d.rationale})`),
    ];
    return `## Ciclo ${c.number}: ${c.verdict === 'approved' ? 'aprovado' : 'reprovado'}
### Problemas apontados pelo revisor
${sent}
### Resposta do Dev
${answers}
${previous}### Anotados e descartados (não voltam ao Dev)
${notes.length > 0 ? notes.join('\n') : '- nada'}
`;
  });
  return [head, ...blocks, renderByTask(cycles)].join('\n');
}

const NO_TASK = 'Sem task';
const NO_MODEL = 'modelo não informado';

/** Groups every item of every cycle by task, then by the model of the reviewer that raised it. */
function renderByTask(cycles: Cycle[]): string {
  const byTask = new Map<string, Map<string, string[]>>();
  for (const c of cycles) {
    const all: [string, Item][] = [
      ...c.sent.map((i): [string, Item] => [
        i.bucket === 'act_on' ? 'agir' : 'considerar',
        i,
      ]),
      ...c.noted.map((i): [string, Item] => ['anotado', i]),
      ...c.dismissed.map((i): [string, Item] => ['descartado', i]),
    ];
    for (const [kind, i] of all) {
      const id = itemTaskId(i);
      const task = id === null ? NO_TASK : `T${id}`;
      const models = i.raised_by.map((l) => c.models[l] || `revisor ${l}`);
      for (const model of models.length > 0 ? models : [NO_MODEL]) {
        const tasks = byTask.get(task) ?? new Map<string, string[]>();
        tasks.set(model, [
          ...(tasks.get(model) ?? []),
          `- (ciclo ${c.number}, ${kind}) ${i.title}: ${i.description}`,
        ]);
        byTask.set(task, tasks);
      }
    }
  }
  const order = (t: string) => (t === NO_TASK ? Infinity : Number(t.slice(1)));
  const blocks = [...byTask.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(
      ([task, models]) =>
        `### ${task}\n${[...models.entries()].map(([model, lines]) => `#### ${model}\n${lines.join('\n')}`).join('\n')}`,
    );
  return `## Apontamentos por task e por modelo\n${blocks.length > 0 ? blocks.join('\n') : '- nenhum apontamento'}\n`;
}

/** Above this many characters the reviewers get a per-file summary and read the files themselves. */
export const MAX_REVIEW_DIFF_CHARS = 60_000;

async function reviewDiff(cwd: string, base: string): Promise<string> {
  const diff = await workingDiff(cwd, base);
  if (diff.length <= MAX_REVIEW_DIFF_CHARS) return diff;
  const stat = await workingDiffStat(cwd, base);
  return `The diff has ${diff.length} characters, over the ${MAX_REVIEW_DIFF_CHARS} limit, so only the per-file summary follows. Read the changed files with Read.\n\n${stat}`;
}

/** The task number an item points at (`T3`, `3`), or null when it names none. */
function itemTaskId(item: Item): number | null {
  const m = item.task ? /\bT?(\d+)\b/i.exec(item.task) : null;
  return m ? Number(m[1]) : null;
}

export type ReviewOptions = {
  /** Commit the diff is taken against. Default `HEAD`: the batch is still uncommitted. */
  base?: string;
  /** Send the items back to the Dev one call per cited task, not one call for all. */
  groupByTask?: boolean;
};

/**
 * The review of one batch (DESIGN 6.1): reviewers in parallel, a lead that sorts the
 * findings, and correction cycles with the Dev. Returns when the batch is approved.
 * Escalates to the human (throws `ReviewEscalation`) on the cycle limit or when an
 * `act_on` item is maintained after the Dev's justification.
 */
export async function reviewBatch(
  ctx: RunContext,
  batch: Batch,
  deps: ReviewDeps,
  /** Sends items back to the Dev and returns its report. `taskIds` are the tasks the items cite. */
  devFix: (feedback: string, taskIds: number[]) => Promise<string>,
  options: ReviewOptions = {},
): Promise<{ cycles: number; reviewPath: string; leftover: Item[] }> {
  const max = ctx.config.max_review_cycles;
  const reviewPath = join(ctx.run.dir, `review-batch-${batch.index}.md`);
  const skill = await loadSkill('review', deps.skillsDir);
  const reviewerTemplate = (
    await readReference('review', 'reviewer-prompt', deps.skillsDir)
  )
    .split('\n---\n')
    .slice(1)
    .join('\n---\n')
    .trim();
  const rubric = await readReference('review', 'rubric', deps.skillsDir);
  const quality = await readReference(
    'review',
    'code-quality-review',
    deps.skillsDir,
  );
  const lead = await readReference('review', 'lead-judgment', deps.skillsDir);
  const inputs = await gatherInputs(ctx, deps.skillsDir);

  let intent = ctx.task;
  try {
    intent = parseSpec(inputs.spec).goal || ctx.task;
  } catch {
    // no valid spec: the task text is the intent
  }
  const lessons = inputs.lessons?.trim() ? inputs.lessons : '(none yet)';

  const reviewerConfigs =
    ctx.config.steps.review.reviewers.length > 0
      ? ctx.config.steps.review.reviewers
      : [
          {
            runner: ctx.config.steps.review.runner,
            model: ctx.config.steps.review.model ?? '',
          },
        ];
  const leadRunner = deps.makeRunner({
    cwd: ctx.cwd,
    runner: ctx.config.steps.review.runner,
    ...(ctx.config.steps.review.model
      ? { model: ctx.config.steps.review.model }
      : {}),
  });

  const cycles: Cycle[] = [];
  let previous: { sent: SentItem[]; answers: DevAnswer[] } | null = null;

  for (let number = 1; number <= max; number++) {
    const diff = await reviewDiff(ctx.cwd, options.base ?? 'HEAD');
    const previousBlock = previous
      ? previous.sent
          .map(
            (s, i) =>
              `${i + 1}. [${s.bucket}] ${line(s)}\n   Dev: ${previous?.answers[i]?.fixed ? 'fixed' : 'not fixed'} - ${previous?.answers[i]?.text ?? ''}`,
          )
          .join('\n')
      : '';

    // 1. Reviewers, one per model, in parallel.
    const results = await Promise.all(
      reviewerConfigs.map(async (cfg, i) => {
        const runner = deps.makeRunner({
          cwd: ctx.cwd,
          runner: cfg.runner,
          ...(cfg.model ? { model: cfg.model } : {}),
        });
        // One pass with a function: inserted text is never re-scanned for tokens
        // and `$&` / `$'` in it are not replacement patterns.
        const values: Record<string, string> = {
          INTENT: intent,
          DIFF_OR_FILES: `\`\`\`diff\n${diff}\n\`\`\``,
          RUBRIC_CONTENTS: rubric,
          CODE_QUALITY_CONTENTS: quality,
          LESSONS: lessons,
          PREVIOUS_CYCLE: previousBlock || '(first cycle)',
        };
        const prompt = reviewerTemplate.replace(
          /\{(INTENT|DIFF_OR_FILES|RUBRIC_CONTENTS|CODE_QUALITY_CONTENTS|LESSONS|PREVIOUS_CYCLE)\}/g,
          (_match, key: string) => values[key] ?? '',
        );
        const [r] = await runSubagents(
          runner,
          [{ id: `reviewer-${label(i)}`, prompt }],
          {
            maxParallel: 1,
            reporter: ctx.reporter,
            origin: 'review',
            via: { runner: cfg.runner, model: cfg.model || undefined },
          },
        );
        return { label: label(i), model: cfg.model, result: r };
      }),
    );
    const reviewerTexts = results.map((r) => {
      const ok = assertAllOk(r.result ? [r.result] : []);
      return `### Reviewer ${r.label}${r.model ? ` (${r.model})` : ''}\n\n${ok[0]?.text ?? ''}`;
    });

    // 2. The lead sorts the findings.
    const leadPrompt = `${skill.body}\n\n---\n\n${lead}\n\n---\n\n# Forge inputs\n\n## Intent\n\n${intent}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n## Findings\n\n${reviewerTexts.join('\n\n')}\n\n## Lessons\n\n${lessons}\n${
      previousBlock ? `\n## Previous cycle\n\n${previousBlock}\n` : ''
    }`;
    const [leadResult] = await runSubagents(
      leadRunner,
      [{ id: 'lead', prompt: leadPrompt, validate: parseLead }],
      {
        maxParallel: 1,
        reporter: ctx.reporter,
        origin: 'review',
        via: {
          runner: ctx.config.steps.review.runner,
          model: ctx.config.steps.review.model,
        },
      },
    );
    const verdictOk = assertAllOk(leadResult ? [leadResult] : [])[0];
    const verdict = parseLead(verdictOk?.text ?? '');
    const computed = computeVerdict(verdict);
    if (computed !== verdict.verdict)
      deps.io.write(
        `O líder disse "${verdict.verdict}", mas os itens pedem "${computed}". Vale o cálculo do Forge.`,
      );

    const sent: SentItem[] = [
      ...verdict.act_on.map((i) => ({ ...i, bucket: 'act_on' as const })),
      ...verdict.consider.map((i) => ({ ...i, bucket: 'consider' as const })),
    ];
    const cycle: Cycle = {
      number,
      verdict: computed,
      sent,
      answers: [],
      noted: verdict.noted,
      dismissed: verdict.dismissed,
      previous: verdict.previous_items,
      models: Object.fromEntries([
        ...results.map((r) => [r.label, r.model] as const),
        ...verdict.reviewers.map((r) => [r.label, r.model] as const),
      ]),
    };
    cycles.push(cycle);

    if (computed === 'approved') {
      await saveArtifact(
        reviewPath,
        renderReview(cycles, 'approved', max),
        () => undefined,
      );
      return { cycles: number, reviewPath, leftover: [] };
    }

    // 3. An act_on item kept after the Dev's justification: straight to the human.
    // A fix the Dev claimed but the reviewer found incomplete goes back to the Dev.
    const keptActOn = verdict.previous_items
      .filter(
        (p) =>
          p.decision === 'maintained' &&
          previous?.answers[p.ref - 1]?.fixed === false,
      )
      .map((p) => previous?.sent[p.ref - 1])
      .filter((i): i is SentItem => i !== undefined && i.bucket === 'act_on');
    const escalate = async (reason: string): Promise<never> => {
      await saveArtifact(
        reviewPath,
        renderReview(cycles, 'escalated', max, reason),
        () => undefined,
      );
      throw new ReviewEscalation(
        `revisão escalada ao humano: ${reason}. Veja ${reviewPath}.`,
        reviewPath,
      );
    };
    if (keptActOn.length > 0) {
      await escalate(
        `o revisor manteve ${keptActOn.length === 1 ? 'um item' : 'itens'} act_on depois da justificativa do Dev (${keptActOn.map((i) => i.title).join('; ')})`,
      );
    }
    if (number === max) {
      // At the limit, only `consider` items left means no real blocker: the batch is
      // approved and the leftovers are noted. An open `act_on` still goes to the human.
      if (verdict.act_on.length === 0) {
        await saveArtifact(
          reviewPath,
          renderReview(cycles, 'approved', max, undefined, sent),
          () => undefined,
        );
        return { cycles: number, reviewPath, leftover: sent };
      }
      await escalate(
        `limite de ${max} ciclos de revisão atingido com itens act_on abertos`,
      );
    }

    // 4. Back to the Dev with the numbered items; items kept from before come along.
    const carried: SentItem[] = verdict.previous_items
      .filter((p) => p.decision === 'maintained')
      .map((p) => previous?.sent[p.ref - 1])
      .filter(
        (i): i is SentItem =>
          i !== undefined && !sent.some((s) => s.title === i.title),
      );
    const toDev = [...sent, ...carried];
    cycle.sent = toDev;
    const feedbackFor = (items: SentItem[]) =>
      `${items.map((s, i) => `${i + 1}. ${line(s)}${s.suggestion ? ` (suggestion: ${s.suggestion})` : ''}`).join('\n')}

Answer every item at the end of your report, one line each: \`N. Corrigido: <what you did>\` or \`N. Não corrigido: <justification>\`.`;
    // One Dev call per cited task keeps each call small; items that cite none go together.
    const groups: { taskIds: number[]; indexes: number[] }[] = [];
    if (options.groupByTask) {
      const byTask = new Map<number | null, number[]>();
      toDev.forEach((item, i) => {
        const id = itemTaskId(item);
        byTask.set(id, [...(byTask.get(id) ?? []), i]);
      });
      for (const [id, indexes] of byTask)
        groups.push({ taskIds: id === null ? [] : [id], indexes });
    } else {
      groups.push({ taskIds: [], indexes: toDev.map((_, i) => i) });
    }
    const answers: DevAnswer[] = [];
    for (const group of groups) {
      const items = group.indexes.map((i) => toDev[i] as SentItem);
      const report = await devFix(feedbackFor(items), group.taskIds);
      parseDevAnswers(report, items.length).forEach((answer, k) => {
        answers[group.indexes[k] as number] = answer;
      });
    }
    cycle.answers = answers;
    previous = { sent: toDev, answers: cycle.answers };
  }
  throw new ReviewEscalation('revisão sem ciclos disponíveis', reviewPath);
}
