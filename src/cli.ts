import { parseArgs } from 'node:util';
import { ArenaEscalation } from './arena.js';
import { logCalls } from './calls.js';
import { join } from 'node:path';
import { createProgressWriter } from './progress.js';
import {
  createProgressReporter,
  type ProgressReporter,
  type ProgressReporterOptions,
} from './progressReporter.js';
import { SubagentEscalation, labelRunner, originLabel } from './subagents.js';
import { loadConfig, type Config, type RunnerName } from './config.js';
import type { IO } from './io.js';
import {
  runWorkflow,
  type RunContext,
  type StageFn,
  type Stages,
  type StageName,
  type TaskSize,
} from './orchestrator.js';
import { PreflightError, preflight } from './preflight.js';
import type { RunnerFactory } from './runner.js';
import { createRun } from './runs.js';
import { NOTHING_TO_RESUME, findIncompleteRun } from './state.js';
import { createBuildStage } from './steps/build.js';
import { createGrillStage } from './steps/grill.js';
import { createHumanStop, type OpenEditor } from './steps/humanStop.js';
import { createLessonsStage } from './steps/lessons.js';
import { createReconStage } from './steps/recon.js';
import { ReviewEscalation } from './steps/review.js';
import { createTasksStage } from './steps/tasks.js';

export const USAGE = `Uso: forge-jj "<tarefa>" [opções]
     forge-jj            (sem argumento: retoma a última execução incompleta)

Opções:
  --size <completo|trivial>   completo: com entrevista (padrão). trivial: pula o Grill
  --review <final|per_task>   final: o revisor confere tudo no fim (padrão). per_task: por tarefa
  --no-arena                  Dev simples, sem arena
  --arena <n>                 número de candidatos do arena
  --refresh-context           refaz o context.md mesmo na execução trivial
  --quiet                     sem progresso no terminal (o progress.jsonl continua sendo gravado)
  -h, --help                  mostra esta ajuda
`;

export type CliDeps = {
  cwd: string;
  isTTY: boolean;
  io: IO;
  /** Builds the factory of runners for a config (isolation, notices). Tests pass fakes. */
  makeRunner: (config: Config) => RunnerFactory;
  openEditor?: OpenEditor;
  /** Where the progress lines go. Default: the process stderr. Tests pass a fake. */
  stderr?: ProgressReporterOptions['stream'];
  env?: NodeJS.ProcessEnv;
};

type Flags = {
  size?: TaskSize;
  review?: 'final' | 'per_task';
  arena?: number;
  noArena: boolean;
  refreshContext: boolean;
  quiet: boolean;
  help: boolean;
  task: string;
};

export class UsageError extends Error {}

export function parseFlags(argv: string[]): Flags {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        size: { type: 'string' },
        review: { type: 'string' },
        'no-arena': { type: 'boolean', default: false },
        arena: { type: 'string' },
        'refresh-context': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const v = parsed.values;
  const flags: Flags = {
    noArena: v['no-arena'] === true,
    refreshContext: v['refresh-context'] === true,
    quiet: v.quiet === true,
    help: v.help === true,
    task: parsed.positionals.join(' ').trim(),
  };
  if (v.size !== undefined) {
    if (v.size === 'completo' || v.size === 'complete') flags.size = 'complete';
    else if (v.size === 'trivial') flags.size = 'trivial';
    else
      throw new UsageError(
        `--size deve ser "completo" ou "trivial", recebi "${v.size}"`,
      );
  }
  if (v.review !== undefined) {
    if (v.review !== 'final' && v.review !== 'per_task')
      throw new UsageError(
        `--review deve ser "final" ou "per_task", recebi "${v.review}"`,
      );
    flags.review = v.review;
  }
  if (v.arena !== undefined) {
    const n = Number(v.arena);
    if (!Number.isInteger(n) || n < 1)
      throw new UsageError(
        `--arena deve ser um inteiro maior que zero, recebi "${v.arena}"`,
      );
    flags.arena = n;
  }
  return flags;
}

/** The two questions of DESIGN 3.2: Enter takes the default. */
async function askChoices(
  io: IO,
  flags: Flags,
  config: Config,
): Promise<{ size: TaskSize; review: 'final' | 'per_task' }> {
  let size: TaskSize = flags.size ?? 'complete';
  if (!flags.size) {
    io.write(
      'Qual o tamanho da tarefa?\n  1) completo: com entrevista (padrão)\n  2) trivial: pula o Grill',
    );
    size = (await io.ask('> ')).trim() === '2' ? 'trivial' : 'complete';
  }
  let review: 'final' | 'per_task' = flags.review ?? config.review_mode;
  if (!flags.review) {
    const perTaskDefault = config.review_mode === 'per_task';
    io.write(
      `Como revisar?\n  1) no final: o revisor confere tudo de uma vez${perTaskDefault ? '' : ' (padrão)'}\n  2) por tarefa: o revisor confere cada tarefa antes da próxima${perTaskDefault ? ' (padrão)' : ''}`,
    );
    const answer = (await io.ask('> ')).trim();
    review =
      answer === '1'
        ? 'final'
        : answer === '2'
          ? 'per_task'
          : config.review_mode;
  }
  return { size, review };
}

/** Each stage gets the runner of its own `steps.<stage>` entry, without copying the context. */
function withRunner(
  stageName: string,
  ctxStage: StageFn,
  pick: (config: Config) => {
    runner: RunnerName;
    model?: string | undefined;
  } | null,
  make: RunnerFactory,
): StageFn {
  return async (ctx) => {
    const choice = pick(ctx.config);
    if (!choice) return ctxStage(ctx);
    const saved = ctx.runner;
    const savedVia = ctx.via;
    const via = { runner: choice.runner, model: choice.model };
    ctx.via = via;
    ctx.runner = labelRunner(
      make({
        cwd: ctx.cwd,
        runner: choice.runner,
        ...(choice.model ? { model: choice.model } : {}),
        allowedCommands: ctx.config.dev.allowed_commands,
      }),
      ctx.reporter,
      originLabel([stageName], via),
      via,
    );
    try {
      await ctxStage(ctx);
    } finally {
      ctx.runner = saved;
      if (savedVia) ctx.via = savedVia;
      else delete ctx.via;
    }
  };
}

export function buildStages(opts: {
  io: IO;
  make: RunnerFactory;
  refreshContext: boolean;
  openEditor?: OpenEditor;
}): Stages {
  const { io, make } = opts;
  const step =
    (name: 'grill' | 'recon' | 'tasks' | 'dev' | 'lessons') => (c: Config) => ({
      runner: c.steps[name].runner,
      model: c.steps[name].model,
    });
  return {
    grill: withRunner('grill', createGrillStage({ io }), step('grill'), make),
    recon: withRunner(
      'recon',
      createReconStage({ io, refreshContext: opts.refreshContext }),
      step('recon'),
      make,
    ),
    tasks: withRunner('tasks', createTasksStage(), step('tasks'), make),
    approve: createHumanStop(io, opts.openEditor),
    build: withRunner(
      'dev',
      createBuildStage({ io, makeRunner: make }),
      step('dev'),
      make,
    ),
    lessons: withRunner(
      'lessons',
      createLessonsStage({ io }),
      step('lessons'),
      make,
    ),
  };
}

/** The `forge-jj` command. Returns the exit code. */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const { io, cwd } = deps;
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    io.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (flags.help) {
    io.write(USAGE);
    return 0;
  }

  let release: (() => Promise<void>) | undefined;
  try {
    const pre = await preflight({
      cwd,
      isTTY: deps.isTTY,
      allowDirty: flags.task === '',
    });
    release = pre.release;
    if (pre.excluded.length > 0)
      io.write(`Adicionei ${pre.excluded.join(' e ')} ao .git/info/exclude.`);

    const config = await loadConfig(cwd);
    if (flags.arena !== undefined) config.dev.arena.candidates = flags.arena;
    if (flags.noArena) config.dev.arena.candidates = 1;
    if (flags.review) config.review_mode = flags.review;

    let task = flags.task;
    let size: TaskSize;
    let run;
    if (task === '') {
      const found = await findIncompleteRun(cwd);
      if (!found) {
        io.write(NOTHING_TO_RESUME);
        return 0;
      }
      ({ task, size } = found.state);
      run = found.run;
      io.write(`Retomando: "${task}" (${found.run.id}).`);
    } else {
      const choices = await askChoices(io, flags, config);
      size = choices.size;
      config.review_mode = choices.review;
      run = await createRun(cwd, task);
    }

    const make = logCalls(
      deps.makeRunner(config),
      join(run.dir, 'calls.jsonl'),
    );
    const reporter: ProgressReporter = createProgressReporter({
      write: createProgressWriter(run.dir, undefined, (error) =>
        (deps.stderr ?? process.stderr).write(
          `Aviso: não consegui gravar o progress.jsonl (${error instanceof Error ? error.message : String(error)}). O log em disco pode estar incompleto.\n`,
        ),
      ),
      stream: deps.stderr ?? process.stderr,
      quiet: flags.quiet,
      ...(deps.env ? { env: deps.env } : {}),
    });
    // The footer must not trample a readline prompt: it is erased while a question waits
    io.setAskHooks?.({
      before: () => reporter.pauseFooter(),
      after: () => reporter.resumeFooter(),
    });
    // Same for stdout lines written while calls run: erase the footer, write, redraw.
    const write = io.write.bind(io);
    io.write = (text) => {
      reporter.pauseFooter();
      try {
        write(text);
      } finally {
        reporter.resumeFooter();
      }
    };
    const ctx: RunContext = {
      reporter,
      cwd,
      task,
      size,
      run,
      config,
      runner: make({ cwd }),
    };
    const stages = buildStages({
      io,
      make,
      refreshContext: flags.refreshContext,
      ...(deps.openEditor ? { openEditor: deps.openEditor } : {}),
    });
    const result = await runWorkflow(ctx, stages);
    io.write(
      result.status === 'completed'
        ? `Pronto. Os artefatos estão em ${run.dir}.`
        : 'Execução cancelada. Rode `forge-jj` sem argumentos para ver se há algo para retomar.',
    );
    return 0;
  } catch (error) {
    if (error instanceof PreflightError) {
      io.write(error.message);
      return 1;
    }
    if (
      error instanceof ReviewEscalation ||
      error instanceof ArenaEscalation ||
      error instanceof SubagentEscalation
    ) {
      io.write(`Parei para você decidir: ${error.message}`);
      return 1;
    }
    io.write(
      `Interrompido: ${(error as Error).message}\nRode \`forge-jj\` sem argumentos para retomar.`,
    );
    return 130;
  } finally {
    await release?.();
    io.close();
  }
}

export type { StageName };
