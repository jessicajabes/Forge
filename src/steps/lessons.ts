import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { saveArtifact } from '../artifacts.js';
import { git } from '../git.js';
import type { IO } from '../io.js';
import type { RunContext, StageFn } from '../orchestrator.js';
import { workflowDir } from '../runs.js';
import { loadReference, loadSkill } from '../skills.js';
import { SubagentEscalation, assertAllOk, runSubagents } from '../subagents.js';

// ---------- what the synthesizer returns ----------

const synthesisSchema = z.object({
  accepted: z
    .array(
      z.object({
        rule: z.string().min(1),
        task: z.string().nullable().default(null),
        evidence: z.string().default(''),
        lenses: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  rejected: z
    .array(z.object({ rule: z.string(), reason: z.string().default('') }))
    .default([]),
});
export type Synthesis = z.infer<typeof synthesisSchema>;

export function parseSynthesis(text: string): Synthesis {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start)
    throw new Error('a resposta do sintetizador não tem JSON');
  return synthesisSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

function validateCandidates(text: string): void {
  if (/^\s*No candidates\.?\s*$/m.test(text)) return;
  if (!/RULE:/.test(text))
    throw new Error(
      'a lente deve devolver candidatos no formato pedido ou "No candidates."',
    );
}

// ---------- the run's artifacts, by lens ----------

type Artifact = { name: string; text: string };

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

const MAX_DIFF_CHARS = 60_000;

/** The diff of every commit this run made, from the parent of the first to the last. */
async function runDiff(cwd: string, runId: string): Promise<string | null> {
  try {
    const hashes = (
      await git(cwd, [
        'log',
        '--format=%H',
        '--reverse',
        `--grep=Forge-Run: ${runId}`,
      ])
    )
      .split('\n')
      .filter((h) => h.length > 0);
    const first = hashes[0];
    const last = hashes[hashes.length - 1];
    if (!first || !last) return null;
    const diff = await git(cwd, ['diff', `${first}^`, last]);
    return diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff cut)`
      : diff;
  } catch {
    return null;
  }
}

async function collect(ctx: RunContext) {
  const dir = ctx.run.dir;
  const arenaNotes: Artifact[] = [];
  try {
    for (const batch of (await readdir(join(dir, 'arena'))).sort()) {
      const text = await readOptional(join(dir, 'arena', batch, 'arena.md'));
      if (text) arenaNotes.push({ name: `arena/${batch}/arena.md`, text });
    }
  } catch {
    // the arena did not run
  }
  const file = async (name: string): Promise<Artifact[]> => {
    const text = await readOptional(join(dir, name));
    return text ? [{ name, text }] : [];
  };
  const diff = await runDiff(ctx.cwd, ctx.run.id);
  return {
    review: await file('review.md'),
    tasks: await file('tasks.md'),
    spec: await file('spec.md'),
    arenaNotes,
    diff: diff
      ? [
          {
            name: 'diff of the commits of this run',
            text: `\`\`\`diff\n${diff}\n\`\`\``,
          },
        ]
      : [],
  };
}

const render = (artifacts: Artifact[]) =>
  artifacts.length === 0
    ? '(nothing available)'
    : artifacts.map((a) => `### ${a.name}\n\n${a.text}`).join('\n\n');

// ---------- lessons.md ----------

const lessonsPath = (cwd: string) => join(workflowDir(cwd), 'lessons.md');

function formatLesson(rule: string, task: string | null, date: Date): string {
  return `- ${rule.trim().replace(/\s+/g, ' ')} (${date.toISOString().slice(0, 10)}, ${task ?? 'geral'})`;
}

const isLesson = (line: string) => line.trimStart().startsWith('- ');

// ---------- the stage ----------

export type LessonsOptions = { io: IO; skillsDir?: string; now?: () => Date };

/**
 * The Lessons stage (DESIGN 6.2): three lenses over the run's artifacts, one synthesizer,
 * then the person approves each proposed rule. Nothing is written without approval.
 */
export function createLessonsStage(options: LessonsOptions): StageFn {
  const { io } = options;
  return async (ctx) => {
    const skill = await loadSkill('lessons', options.skillsDir);
    const art = await collect(ctx);
    const existing = (await readOptional(lessonsPath(ctx.cwd))) ?? '';
    const max = ctx.config.max_lessons;

    // Each lens reads only the slice of the run it needs.
    const lenses = [
      {
        id: 'judgment',
        slice: [...art.review, ...art.tasks, ...art.spec, ...art.diff],
      },
      { id: 'tooling', slice: [...art.arenaNotes, ...art.review, ...art.diff] },
      {
        id: 'divergent',
        slice: [...art.review, ...art.arenaNotes, ...art.spec],
      },
    ];
    const specs = [];
    for (const lens of lenses) {
      const template = await loadReference(
        'lessons',
        `${lens.id}-reviewer`,
        options.skillsDir,
      );
      specs.push({
        id: lens.id,
        prompt: `${skill.body}\n\n---\n\n${template.replace('{ARTIFACTS}', render(lens.slice))}`,
        validate: validateCandidates,
      });
    }

    let synthesis: Synthesis;
    try {
      const results = await runSubagents(ctx.runner, specs, {
        maxParallel: ctx.config.subagents.max_parallel,
      });
      const ok = assertAllOk(results);
      const candidates = ok
        .map((r) => `### Lens: ${r.id}\n\n${r.text}`)
        .join('\n\n');
      if (
        ok.every(
          (r) =>
            /^\s*No candidates\.?\s*$/m.test(r.text) && !/RULE:/.test(r.text),
        )
      ) {
        io.write('Nenhuma lição nova nesta execução.');
        return;
      }
      const template = await loadReference(
        'lessons',
        'synthesizer',
        options.skillsDir,
      );
      const [synth] = await runSubagents(
        ctx.runner,
        [
          {
            id: 'synthesizer',
            prompt: `${skill.body}\n\n---\n\n${template.replace('{LESSONS}', existing.trim() || '(none yet)').replace('{CANDIDATES}', candidates)}`,
            validate: parseSynthesis,
          },
        ],
        { maxParallel: 1 },
      );
      synthesis = parseSynthesis(
        assertAllOk(synth ? [synth] : [])[0]?.text ?? '',
      );
    } catch (error) {
      if (!(error instanceof SubagentEscalation)) throw error;
      io.write(
        `As lições ficaram de fora desta vez: ${error.message}. A execução em si terminou.`,
      );
      return;
    }

    if (synthesis.accepted.length === 0) {
      io.write('Nenhuma lição nova nesta execução.');
      return;
    }

    let lines =
      existing.trim() === '' ? [] : existing.replace(/\n+$/, '').split('\n');
    const lessonCount = () => lines.filter(isLesson).length;
    const save = () =>
      saveArtifact(
        lessonsPath(ctx.cwd),
        `${lines.join('\n').replace(/\n+$/, '')}\n`,
        () => undefined,
      );
    const now = options.now?.() ?? new Date();

    for (const lesson of synthesis.accepted) {
      let rule = lesson.rule;
      io.write(
        `\nLição proposta: ${rule}${lesson.evidence ? `\n  Evidência: ${lesson.evidence}` : ''}`,
      );
      const answer = (await io.ask('Gravar? [sim / não / editar]: '))
        .trim()
        .toLowerCase();
      if (answer.startsWith('e')) {
        const edited = (await io.ask('Nova redação: ')).trim();
        if (edited === '') continue;
        rule = edited;
      } else if (!answer.startsWith('s')) {
        continue;
      }

      if (lessonCount() >= max) {
        io.write(`O limite de ${max} lições foi atingido. As atuais:`);
        const current = lines.filter(isLesson);
        current.forEach((l, i) =>
          io.write(`${i + 1}. ${l.trimStart().slice(2)}`),
        );
        const removeAnswer = (
          await io.ask(
            'Números a remover (ex.: 2,5), ou Enter para não gravar esta: ',
          )
        ).trim();
        const remove = new Set(
          removeAnswer
            .split(/[,\s]+/)
            .map((n) => Number(n))
            .filter(
              (n) => Number.isInteger(n) && n >= 1 && n <= current.length,
            ),
        );
        if (remove.size === 0) continue;
        const drop = new Set([...remove].map((n) => current[n - 1]));
        lines = lines.filter((l) => !(isLesson(l) && drop.has(l)));
      }
      lines.push(formatLesson(rule, lesson.task, now));
      await save();
    }
  };
}
