import { join } from 'node:path';
import { z } from 'zod';
import { parseSpec, saveArtifact } from '../artifacts.js';
import type { IO } from '../io.js';
import type { RunContext, StageFn } from '../orchestrator.js';
import type { Runner } from '../runner.js';
import { loadSkill } from '../skills.js';
import { assertAllOk, runSubagents } from '../subagents.js';

// ---------- what the model returns for one step ----------

const moveSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('question'),
    title: z.string().min(1),
    body: z.string().min(1),
    recommended: z.string().min(1),
  }),
  z.object({ action: z.literal('ready') }),
  z.object({ action: z.literal('help'), text: z.string().min(1) }),
]);

export type GrillMove = z.infer<typeof moveSchema>;

/** Extracts the JSON object from the model's reply, even if it wrapped it in a code fence. */
export function parseMove(text: string): GrillMove {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start)
    throw new Error('a resposta não tem um objeto JSON');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('o JSON da resposta é inválido');
  }
  const result = moveSchema.safeParse(raw);
  if (!result.success)
    throw new Error(result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

// ---------- the interview state (saved as a draft by T16) ----------

export type Answer =
  | { kind: 'accepted' }
  | { kind: 'custom'; text: string }
  /** The person did not know twice: the recommendation was followed, marked provisional. */
  | { kind: 'provisional' }
  /** `depois`: the only way to create an open point. */
  | { kind: 'later' };

export type Question = {
  number: number;
  title: string;
  body: string;
  recommended: string;
};
export type Turn =
  | { type: 'qa'; question: Question; answer: Answer }
  | { type: 'correction'; text: string };

export type GrillState = {
  turns: Turn[];
  /** The question on screen, not answered yet. */
  pending: Question | null;
  /** How many times the person said "não sei" to the pending question. */
  doubts: number;
};

export const emptyGrillState = (): GrillState => ({
  turns: [],
  pending: null,
  doubts: 0,
});

const describeAnswer = (a: Answer): string => {
  switch (a.kind) {
    case 'accepted':
      return 'accepted the recommended answer';
    case 'custom':
      return `answered: ${a.text}`;
    case 'provisional':
      return 'did not know; the recommendation was followed. Mark this decision (provisória)';
    case 'later':
      return 'postponed. This is an open point';
  }
};

function renderTurns(state: GrillState): string {
  if (state.turns.length === 0) return '(nothing decided yet)';
  return state.turns
    .map((t) =>
      t.type === 'correction'
        ? `Correction from the user after reading the summary: ${t.text}`
        : `Q${t.question.number} - ${t.question.title}\n  Question: ${t.question.body}\n  Recommended: ${t.question.recommended}\n  User: ${describeAnswer(t.answer)}`,
    )
    .join('\n\n');
}

// ---------- prompts ----------

const JSON_RULES =
  'Reply with ONE JSON object and nothing else: no code fence, no text before or after it.';

function buildPrompt(
  skillBody: string,
  task: string,
  state: GrillState,
  step:
    | { kind: 'next' }
    | { kind: 'help'; question: Question }
    | { kind: 'summary'; unanswered: Question | null },
): string {
  const head = `${skillBody}

---

# Forge protocol

The Forge drives this interview in code. You only produce the next step. You have read-only access to the repository: use it to find facts instead of asking the user. Write in the language the task is written in.

## Task

${task}

## Conversation so far

${renderTurns(state)}
`;
  switch (step.kind) {
    case 'next':
      return `${head}
## Now

Pick the next question from the frontier: the one whose answer most narrows what is left. Ask one question only. If the frontier is empty and every branch has been visited, reply {"action":"ready"}.

${JSON_RULES}

Question: {"action":"question","title":"<short title>","body":"<the question, worded so \\"yes\\" accepts the recommendation>","recommended":"<your recommended answer>"}
Done: {"action":"ready"}
`;
    case 'help':
      return `${head}
## Now

The user does not know how to answer Q${step.question.number} - ${step.question.title}. Break the question down, give alternatives, explain what each one influences, and keep your recommendation with the reason.

${JSON_RULES}

{"action":"help","text":"<your explanation>"}
`;
    case 'summary':
      return `${head}
## Now

Write the spec for this task. Reply with the Markdown of the file and nothing else, using exactly this structure:

# Spec: <title>

## Objetivo
## Decisões
## Fora do escopo
## Restrições
## Pontos em aberto

Rules:
- Each decision taken in the interview is one bullet in "Decisões". A decision marked provisional ends with (provisória).
- "Pontos em aberto" has only what was postponed${step.unanswered ? ', plus the question that was on screen and got no answer:' : ''}${step.unanswered ? ` "${step.unanswered.title}: ${step.unanswered.body}"` : ''}. If there is nothing, write "- nenhum".
- "Fora do escopo" and "Restrições" take what the interview established. If nothing, write "- nenhum" or "- nenhuma".
- Do not add a "how to implement" section. Keep the section names and bullets in Portuguese.
`;
  }
}

// ---------- the stage ----------

const YES = new Set(['', 's', 'sim', 'y', 'yes']);
const norm = (s: string) =>
  s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export type GrillOptions = {
  io: IO;
  skillsDir?: string;
  /** Start from a saved draft (T16). */
  initial?: GrillState;
  /** Called after every change of the state, so a draft can be saved (T16). */
  onProgress?: (state: GrillState) => void | Promise<void>;
};

async function callModel<T>(
  runner: Runner,
  id: string,
  prompt: string,
  validate: (text: string) => T,
  maxParallel: number,
): Promise<{ text: string; value: T }> {
  const [result] = await runSubagents(runner, [{ id, prompt, validate }], {
    maxParallel,
  });
  const [ok] = assertAllOk(result ? [result] : []);
  const text = ok?.text ?? '';
  return { text, value: validate(text) };
}

/**
 * The interview of DESIGN 4.8: one question at a time, each with a recommendation.
 * `spec.md` is only written after the person confirms the summary.
 */
export function createGrillStage(options: GrillOptions): StageFn {
  const { io } = options;
  return async (ctx: RunContext) => {
    const skill = await loadSkill('grill', options.skillsDir);
    const state: GrillState = options.initial ?? emptyGrillState();
    const save = async () => options.onProgress?.(state);
    let nextNumber =
      Math.max(
        0,
        state.pending?.number ?? 0,
        ...state.turns.map((t) => (t.type === 'qa' ? t.question.number : 0)),
      ) + 1;

    const move = (step: Parameters<typeof buildPrompt>[3]) =>
      callModel(
        ctx.runner,
        `grill-${step.kind}`,
        buildPrompt(skill.body, ctx.task, state, step),
        parseMove,
        1,
      );

    const writeSummary = async (
      unanswered: Question | null,
    ): Promise<boolean> => {
      const { text: spec } = await callModel(
        ctx.runner,
        'grill-summary',
        buildPrompt(skill.body, ctx.task, state, {
          kind: 'summary',
          unanswered,
        }),
        (t) => parseSpec(t),
        1,
      );
      io.write(spec);
      const parsed = parseSpec(spec);
      if (parsed.openPoints.length > 0) {
        io.write(
          'Atenção: o resumo ainda tem pontos em aberto. Eles seguem para as Tarefas sem resposta.',
        );
      }
      const answer = await io.ask(
        'Confirma o resumo? (sim, ou diga o que falta): ',
      );
      if (YES.has(norm(answer))) {
        await saveArtifact(join(ctx.run.dir, 'spec.md'), spec, parseSpec);
        return true;
      }
      state.turns.push({ type: 'correction', text: answer.trim() });
      state.pending = null;
      await save();
      return false;
    };

    for (;;) {
      if (!state.pending) {
        const { value } = await move({ kind: 'next' });
        if (value.action === 'ready') {
          if (await writeSummary(null)) return;
          continue;
        }
        if (value.action !== 'question') continue;
        state.pending = {
          number: nextNumber++,
          title: value.title,
          body: value.body,
          recommended: value.recommended,
        };
        state.doubts = 0;
        await save();
      }

      const q = state.pending;
      io.write(
        `\nQ${q.number} - ${q.title}\n${q.body}\nRecomendado: ${q.recommended}`,
      );
      const raw = await io.ask('> ');
      const answer = norm(raw);

      if (answer === 'chega') {
        const unanswered = state.pending;
        state.pending = null;
        if (await writeSummary(unanswered)) return;
        continue;
      }
      if (answer === 'voltar') {
        const last = [...state.turns].reverse().find((t) => t.type === 'qa');
        if (!last || last.type !== 'qa') {
          io.write('Não há resposta anterior para desfazer.');
          continue;
        }
        // the question on screen is dropped, and the last answered one is asked again
        state.turns.splice(state.turns.lastIndexOf(last), 1);
        state.pending = last.question;
        nextNumber = last.question.number + 1;
        state.doubts = 0;
        await save();
        continue;
      }
      if (answer === 'depois') {
        state.turns.push({
          type: 'qa',
          question: q,
          answer: { kind: 'later' },
        });
        state.pending = null;
        await save();
        continue;
      }
      if (answer === 'nao sei') {
        state.doubts++;
        if (state.doubts === 1) {
          const { value } = await move({ kind: 'help', question: q });
          io.write(
            value.action === 'help'
              ? value.text
              : 'Siga a recomendação se não tiver preferência.',
          );
          await save();
          continue;
        }
        state.turns.push({
          type: 'qa',
          question: q,
          answer: { kind: 'provisional' },
        });
        io.write(
          'Seguindo a recomendação e marcando a decisão como provisória.',
        );
        state.pending = null;
        await save();
        continue;
      }
      state.turns.push({
        type: 'qa',
        question: q,
        answer: YES.has(answer)
          ? { kind: 'accepted' }
          : { kind: 'custom', text: raw.trim() },
      });
      state.pending = null;
      await save();
    }
  };
}
