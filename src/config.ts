import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const runnerName = z.enum(['claude-cli', 'copilot-cli']);
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
    review_mode: z.enum(['final', 'per_task']).default('final'),
    max_review_cycles: z.number().int().positive().default(3),
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
        // Not set: follows `review_mode` (one batch per task when the review is per task)
        batching: z.enum(['per_task', 'all']).optional(),
        // Editing calls have no limit unless these are set
        max_turns: z.number().int().positive().optional(),
        timeout_minutes: z.number().positive().optional(),
        arena: z
          .object({
            candidates: z.number().int().positive().default(3),
            models: z.array(z.string()).optional(),
            judge: reviewerConfig.optional(),
          })
          .strict()
          .default({ candidates: 3 }),
      })
      .strict()
      .default({
        allowed_commands: ['npm test', 'npm run lint', 'npx prettier'],
        arena: { candidates: 3 },
      }),
    claude: z
      .object({ isolated: z.boolean().default(true) })
      .strict()
      .default({ isolated: true }),
  })
  .strict()
  .refine((c) => c.max_context_tokens.warn < c.max_context_tokens.limit, {
    message: 'max_context_tokens.warn deve ser menor que limit',
  })
  .refine((c) => !(c.review_mode === 'per_task' && c.dev.batching === 'all'), {
    message:
      'review_mode: per_task exige um Dev por tarefa; troque dev.batching para per_task ou tire essa linha',
  });

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
