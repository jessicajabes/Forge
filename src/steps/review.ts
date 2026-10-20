import { join } from 'node:path';
import { z } from 'zod';
import { parseSpec, saveArtifact } from '../artifacts.js';
import { workingDiff } from '../git.js';
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
): string {
  const head = `# Revisão

## Resumo
- **Veredito**: ${status === 'approved' ? 'aprovado' : 'escalado ao humano'}
- **Ciclos realizados**: ${cycles.length} de ${max}${reason ? `\n- **Motivo da escalada**: ${reason}` : ''}
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
  return [head, ...blocks].join('\n');
}

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
  /** Sends items back to the Dev and returns its report. */
  devFix: (feedback: string) => Promise<string>,
): Promise<{ cycles: number; reviewPath: string }> {
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
    const diff = await workingDiff(ctx.cwd);
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
        const prompt = reviewerTemplate
          .replace('{INTENT}', intent)
          .replace('{DIFF_OR_FILES}', `\`\`\`diff\n${diff}\n\`\`\``)
          .replace('{RUBRIC_CONTENTS}', rubric)
          .replace('{CODE_QUALITY_CONTENTS}', quality)
          .replace('{LESSONS}', lessons)
          .replace('{PREVIOUS_CYCLE}', previousBlock || '(first cycle)');
        const [r] = await runSubagents(
          runner,
          [{ id: `reviewer-${label(i)}`, prompt }],
          {
            maxParallel: 1,
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
      { maxParallel: 1 },
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
    };
    cycles.push(cycle);

    if (computed === 'approved') {
      await saveArtifact(
        reviewPath,
        renderReview(cycles, 'approved', max),
        () => undefined,
      );
      return { cycles: number, reviewPath };
    }

    // 3. An act_on item kept after the Dev's justification: straight to the human.
    const keptActOn = verdict.previous_items
      .filter((p) => p.decision === 'maintained')
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
    if (number === max)
      await escalate(
        `limite de ${max} ciclos de revisão atingido com itens abertos`,
      );

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
    const feedback = `${toDev.map((s, i) => `${i + 1}. ${line(s)}${s.suggestion ? ` (suggestion: ${s.suggestion})` : ''}`).join('\n')}

Answer every item at the end of your report, one line each: \`N. Corrigido: <what you did>\` or \`N. Não corrigido: <justification>\`.`;
    const report = await devFix(feedback);
    cycle.answers = parseDevAnswers(report, toDev.length);
    previous = { sent: toDev, answers: cycle.answers };
  }
  throw new ReviewEscalation('revisão sem ciclos disponíveis', reviewPath);
}
