import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseSpec, saveArtifact, type Task } from '../artifacts.js';
import { workingDiff, workingDiffStat } from '../git.js';
import type { IO } from '../io.js';
import type { RunContext } from '../orchestrator.js';
import type { Runner, RunnerFactory } from '../runner.js';
import { readReference, loadSkill } from '../skills.js';
import { assertAllOk, runSubagents } from '../subagents.js';
import { taskDocPath } from '../taskDocs.js';
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
export type Cycle = {
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

/** `rejected` describes a cycle that went back to the Dev: nothing is left for a person yet. */
export type ReviewStatus = 'approved' | 'rejected' | 'escalated';

const label = (i: number) => String.fromCharCode(65 + i);
const line = (i: Item) =>
  `${i.task ? `[${i.task}] ` : ''}${i.title}: ${i.description}`;

/** The items nobody can settle but a person: what the run escalated, or approved at the cycle limit. */
function humanItems(
  cycles: Cycle[],
  status: ReviewStatus,
  leftover: Item[],
): Item[] {
  if (status === 'rejected') return [];
  return status === 'escalated' ? (cycles.at(-1)?.sent ?? []) : leftover;
}

const HUMAN_TITLE = '## 🔴 DEPENDE DE AÇÃO HUMANA';
const NO_HUMAN = '## ✅ Nada depende de ação humana';

/** The red block: what needs a person, why, and what the person does about it. */
function renderHuman(
  items: Item[],
  status: ReviewStatus,
  reason?: string,
  heading = HUMAN_TITLE,
): string {
  if (status === 'rejected' || (status === 'approved' && items.length === 0))
    return `${NO_HUMAN}\n`;
  const todo =
    status === 'escalated'
      ? 'Decida: corrigir o item à mão ou aceitá-lo. Depois retome a execução.'
      : 'Decida: aceitar o item como está ou criar uma task nova para ele.';
  const why =
    status === 'escalated'
      ? `A revisão parou e **não vai continuar sozinha**.${reason ? ` Motivo: ${reason}.` : ''}`
      : 'A revisão foi aprovada no limite de ciclos, mas estes itens ficaram em aberto e **ninguém vai tratá-los sozinho**.';
  return `${heading}
> 🔴 **PRECISA DE VOCÊ.** ${why}
> 🔴 **O que fazer**: ${todo}

${items.map((i, n) => `${n + 1}. 🔴 ${line(i)}`).join('\n')}
`;
}

export function renderReview(
  cycles: Cycle[],
  status: ReviewStatus,
  max: number,
  reason?: string,
  /** `consider` items still open when the cycle limit approved the batch. */
  leftover: Item[] = [],
  /** Cycle files already on disk from earlier attempts; cycle numbers continue after them. */
  fileOffset = 0,
): string {
  const range =
    fileOffset > 0
      ? ` nesta tentativa (ciclos ${fileOffset + 1} a ${fileOffset + cycles.length} do lote)`
      : '';
  const atLimit =
    leftover.length > 0
      ? `\n- **Aprovado no limite de ciclos**: ${leftover.length} ${leftover.length === 1 ? 'item' : 'itens'} \`consider\` ficaram em aberto e foram anotados, sem voltar ao Dev: ${leftover.map((i) => i.title).join('; ')}`
      : '';
  const human = renderHuman(
    humanItems(cycles, status, leftover),
    status,
    reason,
  );
  const head = `# Revisão

## Resumo
- **Veredito**: ${status === 'approved' ? 'aprovado' : status === 'rejected' ? 'reprovado' : '🔴 escalado ao humano'}
- **Ciclos realizados**: ${cycles.length} de ${max}${range}${atLimit}${reason ? `\n- **Motivo da escalada**: ${reason}` : ''}
- **Depende de ação humana**: ${human.startsWith(HUMAN_TITLE) ? '🔴 SIM, veja o bloco abaixo' : 'não'}

${human}`;
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

/**
 * One review document per task (`tarefas/T<n>/review.md`): what the reviewers raised about it,
 * what the Dev answered, and, in red, what only a person can settle. Items that name no task go
 * to the batch's only task, or to `geral`.
 */
function renderTaskReviews(
  cycles: Cycle[],
  status: ReviewStatus,
  reason: string | undefined,
  leftover: Item[],
  only: Task | undefined,
): Map<number | 'geral', string> {
  const idOf = (i: Item): number | 'geral' =>
    itemTaskId(i) ?? only?.id ?? 'geral';
  type Entry = { kind: string; item: Item; cycle: number; answer?: DevAnswer };
  const byTask = new Map<number | 'geral', Entry[]>();
  const add = (e: Entry) =>
    byTask.set(idOf(e.item), [...(byTask.get(idOf(e.item)) ?? []), e]);
  for (const c of cycles) {
    c.sent.forEach((item, n) =>
      add({
        kind: item.bucket === 'act_on' ? 'agir' : 'considerar',
        item,
        cycle: c.number,
        ...(c.answers[n] ? { answer: c.answers[n] } : {}),
      }),
    );
    for (const item of c.noted) add({ kind: 'anotado', item, cycle: c.number });
    for (const item of c.dismissed)
      add({ kind: 'descartado', item, cycle: c.number });
  }
  const humanByTask = new Map<number | 'geral', Item[]>();
  for (const item of humanItems(cycles, status, leftover))
    humanByTask.set(idOf(item), [...(humanByTask.get(idOf(item)) ?? []), item]);
  const docs = new Map<number | 'geral', string>();
  for (const [id, entries] of byTask) {
    const models = (e: Entry) =>
      cycles.find((c) => c.number === e.cycle)?.models;
    const row = (e: Entry) => {
      const who = e.item.raised_by
        .map((l) => models(e)?.[l] || `revisor ${l}`)
        .join(', ');
      const answer = e.answer
        ? `\n   - Dev: ${e.answer.fixed ? 'Corrigido' : 'Não corrigido'}: ${e.answer.text}`
        : '';
      return `- (ciclo ${e.cycle}, ${e.kind}${who ? `, ${who}` : ''}) ${e.item.title}: ${e.item.description}${answer}`;
    };
    const section = (title: string, kinds: string[]) => {
      const rows = entries.filter((e) => kinds.includes(e.kind)).map(row);
      return `## ${title}\n${rows.length > 0 ? rows.join('\n') : '- nada'}\n`;
    };
    const human = humanByTask.get(id) ?? [];
    docs.set(
      id,
      `# Revisão ${id === 'geral' ? 'geral' : `da T${id}`}

${
  human.length > 0
    ? renderHuman(human, status, reason, '## 🔴 DEPENDE DE AÇÃO HUMANA')
    : '## ✅ Nada desta task depende de ação humana\n'
}
${section('Pedidos de correção e resposta do Dev', ['agir', 'considerar'])}
${section('Anotados (não voltam ao Dev)', ['anotado'])}
${section('Descartados', ['descartado'])}`,
    );
  }
  // A task with no finding at all still gets its document
  return docs;
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
  const reviewPath = join(ctx.run.dir, `review-lote-${batch.index}.md`);
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
  // A batch of its own is reviewed against its own tasks: the later tasks of the plan stay out of it
  if (batch.total > 1) {
    const own = batch.tasks
      .map((t) => inputs.blocks.get(t.id) ?? `## T${t.id}: ${t.title}`)
      .join('\n\n');
    intent = `${intent}\n\nThis diff implements only the tasks below, which are part of a longer plan. Review only them: do not report what other tasks of the plan will do later.\n\n${own}`;
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
  // A resumed batch numbers its cycle files after the ones already on disk, so none is overwritten.
  const cyclePattern = new RegExp(
    `^review-lote-${batch.index}-ciclo-(\\d+)\\.md$`,
  );
  const fileOffset = Math.max(
    0,
    ...(await readdir(ctx.run.dir)).map((f) =>
      Number(cyclePattern.exec(f)?.[1] ?? 0),
    ),
  );
  /** Saves `review-lote-N-ciclo-K.md`: the cycles up to the last one, so a rejected cycle leaves a record. */
  const saveCycle = async (
    status: ReviewStatus,
    reason?: string,
    leftover: Item[] = [],
  ) => {
    await saveArtifact(
      join(
        ctx.run.dir,
        `review-lote-${batch.index}-ciclo-${fileOffset + cycles.length}.md`,
      ),
      renderReview(cycles, status, max, reason, leftover, fileOffset),
      () => undefined,
    );
  };
  /** Saves the batch report and, beside it, one review document per task. */
  const persist = async (
    status: 'approved' | 'escalated',
    reason?: string,
    leftover: Item[] = [],
  ) => {
    await saveCycle(status, reason, leftover);
    await saveArtifact(
      reviewPath,
      renderReview(cycles, status, max, reason, leftover, fileOffset),
      () => undefined,
    );
    const docs = renderTaskReviews(
      cycles,
      status,
      reason,
      leftover,
      batch.tasks.length === 1 ? batch.tasks[0] : undefined,
    );
    for (const [id, text] of docs)
      await saveArtifact(
        taskDocPath(ctx.run.dir, id, 'review.md'),
        text,
        () => undefined,
      );
  };
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
        const base = deps.makeRunner({
          cwd: ctx.cwd,
          runner: cfg.runner,
          ...(cfg.model ? { model: cfg.model } : {}),
        });
        // The model the CLI says it ran, when the provider reports one.
        let reported = '';
        const runner: Runner = (req) =>
          base({
            ...req,
            onEvent: (event) => {
              if (event.type === 'model') reported = event.model;
              req.onEvent?.(event);
            },
          });
        if (base.limitFor) runner.limitFor = base.limitFor;
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
        // Config first, then what the runner reported, then the runner name.
        return {
          label: label(i),
          model: cfg.model || reported || cfg.runner,
          configured: cfg.model,
          result: r,
        };
      }),
    );
    const reviewerTexts = results.map((r) => {
      const ok = assertAllOk(r.result ? [r.result] : []);
      return `### Reviewer ${r.label}${r.configured ? ` (${r.configured})` : ''}\n\n${ok[0]?.text ?? ''}`;
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
      number: fileOffset + number,
      verdict: computed,
      sent,
      answers: [],
      noted: verdict.noted,
      dismissed: verdict.dismissed,
      previous: verdict.previous_items,
      models: Object.fromEntries([
        // The lead's name is only a last resort, and is marked as such.
        ...verdict.reviewers.map(
          (r) => [r.label, `${r.model} (informado pelo líder)`] as const,
        ),
        ...results.map((r) => [r.label, r.model] as const),
      ]),
    };
    cycles.push(cycle);

    if (computed === 'approved') {
      await persist('approved');
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
      await persist('escalated', reason);
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
        await persist('approved', undefined, sent);
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
    // Keeps the cycle on disk in case the Dev fails.
    await saveCycle('rejected');
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
    await saveCycle('rejected');
    previous = { sent: toDev, answers: cycle.answers };
  }
  throw new ReviewEscalation('revisão sem ciclos disponíveis', reviewPath);
}
