import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const runnerName = z.enum(['claude-cli', 'copilot-cli', 'antigravity-cli']);
export type RunnerName = z.infer<typeof runnerName>;

const stepConfig = z
  .object({
    runner: runnerName.default('claude-cli'),
    model: z.string().optional(),
  })
  .strict()
  .default({ runner: 'claude-cli' });

const reviewerConfig = z
  .object({ runner: runnerName, model: z.string() })
  .strict();

const configSchema = z
  .object({
    steps: z
      .object({
        grill: stepConfig,
        recon: stepConfig,
        tasks: stepConfig,
        dev: stepConfig,
        lessons: stepConfig,
        review: z
          .object({
            runner: runnerName.default('claude-cli'),
            model: z.string().optional(),
            reviewers: z.array(reviewerConfig).default([]),
          })
          .strict()
          .default({ runner: 'claude-cli', reviewers: [] }),
      })
      .strict()
      .default({
        grill: { runner: 'claude-cli' },
        recon: { runner: 'claude-cli' },
        tasks: { runner: 'claude-cli' },
        dev: { runner: 'claude-cli' },
        lessons: { runner: 'claude-cli' },
        review: { runner: 'claude-cli', reviewers: [] },
      }),
    // Not set: resolved after the parse (final, or per_task when dev.batching is per_task and nothing says otherwise)
    review_mode: z.enum(['final', 'per_task']).optional(),
    max_review_cycles: z.number().int().positive().default(10),
    max_lessons: z.number().int().positive().default(30),
    max_context_tokens: z
      .object({
        warn: z.number().int().positive().default(80_000),
        limit: z.number().int().positive().default(100_000),
      })
      .strict()
      .default({ warn: 80_000, limit: 100_000 }),
    subagents: z
      .object({ max_parallel: z.number().int().positive().default(3) })
      .strict()
      .default({ max_parallel: 3 }),
    dev: z
      .object({
        allowed_commands: z
          .array(z.string())
          .default(['npm test', 'npm run lint', 'npx prettier']),
        // What the build runs once at the end to check the result (a failure goes back
        // to the Dev). Not the same as `allowed_commands`:
        // those are what a candidate may run, and may include formatters that write
        check_commands: z
          .array(z.string())
          .default(['npm test', 'npm run lint']),
        // Not set: follows `review_mode` (one batch per task when the review is per task)
        batching: z.enum(['per_task', 'all']).optional(),
        // Editing calls have no limit unless these are set
        max_turns: z.number().int().positive().optional(),
        timeout_minutes: z.number().positive().optional(),
        arena: z
          .object({
            // Opt-in: the arena only runs when this is set to true
            enabled: z.boolean().default(false),
            candidates: z.number().int().positive().default(3),
            models: z.array(z.string()).optional(),
            judge: reviewerConfig.optional(),
          })
          .strict()
          .default({ enabled: false, candidates: 3 }),
      })
      .strict()
      .default({
        allowed_commands: ['npm test', 'npm run lint', 'npx prettier'],
        check_commands: ['npm test', 'npm run lint'],
        arena: { enabled: false, candidates: 3 },
      }),
    claude: z
      .object({
        isolated: z.boolean().default(true),
        // A claude with no output for this long is killed (a hung call); 0 turns it off
        inactivity_kill_minutes: z.number().nonnegative().default(2),
      })
      .strict()
      .default({ isolated: true, inactivity_kill_minutes: 2 }),
  })
  .strict()
  .refine((c) => c.max_context_tokens.warn < c.max_context_tokens.limit, {
    message: 'max_context_tokens.warn deve ser menor que limit',
  })
  .refine((c) => !(c.review_mode === 'per_task' && c.dev.batching === 'all'), {
    message:
      'review_mode: per_task exige um Dev por tarefa; troque dev.batching para per_task ou tire essa linha',
  })
  .transform((c) => ({
    ...c,
    // Implicit default: final (one Dev call for every task, then the checks, then one review)
    review_mode: c.review_mode ?? 'final',
  }));

export type Config = z.infer<typeof configSchema>;

/**
 * How the Dev splits the tasks into calls. A per-task review needs a Dev per task, so
 * it wins over `dev.batching`; otherwise `dev.batching` decides (default: one call for all).
 */
export function devBatching(
  config: Pick<Config, 'review_mode' | 'dev'>,
): 'per_task' | 'all' {
  if (config.review_mode === 'per_task') return 'per_task';
  return config.dev.batching ?? 'all';
}

/** Parses config text. Empty or missing sections take the defaults of DESIGN 4.4. */
export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (error) {
    throw new ConfigError(
      `.workflow.yml inválido: ${(error as Error).message}`,
    );
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`,
    );
    throw new ConfigError(`.workflow.yml inválido: ${problems.join('; ')}`);
  }
  return result.data;
}

/** Workflow written to a repo that has no `.workflow.yml`. The arena stays opt-in (no `enabled`). */
export const DEFAULT_WORKFLOW_YML = `steps:
  grill:
    runner: claude-cli
    model: claude-opus-5-5
  recon:
    runner: claude-cli
    model: claude-haiku-5-5
  tasks:
    runner: claude-cli
    model: claude-haiku-5-5
  dev:
    runner: claude-cli
    model: claude-sonnet-5-5
  review:
    runner: claude-cli
    model: claude-opus-5-5
    reviewers:
      - runner: claude-cli
        model: claude-sonnet-5-5
      - runner: copilot-cli
        model: auto
  lessons:
    runner: claude-cli
    model: claude-haiku-5-5
dev:
  arena:
    candidates: 3
    judge:
      runner: claude-cli
      model: claude-opus-5-5
`;

/** Writes `DEFAULT_WORKFLOW_YML` only when `.workflow.yml` is missing; returns whether it created it. */
export async function ensureWorkflowFile(cwd: string): Promise<boolean> {
  try {
    await writeFile(join(cwd, '.workflow.yml'), DEFAULT_WORKFLOW_YML, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Loads `.workflow.yml` from the target repo; a missing file means all defaults. */
export async function loadConfig(cwd: string): Promise<Config> {
  let text = '';
  try {
    text = await readFile(join(cwd, '.workflow.yml'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return parseConfig(text);
}
