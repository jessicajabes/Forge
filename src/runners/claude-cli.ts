import { spawn, type ChildProcess } from 'node:child_process';
import { maskSecrets } from '../progress.js';
import {
  INACTIVITY_MS,
  INACTIVITY_REPEAT_MS,
  summarizeToolArg,
} from '../progress.js';
import {
  RunnerError,
  RunnerTimeoutError,
  type RunRequest,
  type Runner,
  type RunnerEvent,
} from '../runner.js';

export class ClaudeCliError extends RunnerError {
  constructor(
    message: string,
    details: { stderr?: string; exitCode?: number | null } = {},
  ) {
    super(message, details);
    this.name = 'ClaudeCliError';
  }
}

/** Timers of a call. Each `set*` returns the function that cancels it. Tests inject a fake. */
export type Clock = {
  setTimeout: (fn: () => void, ms: number) => () => void;
  setInterval: (fn: () => void, ms: number) => () => void;
  now: () => number;
};

const realClock: Clock = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  now: () => Date.now(),
};

export type ClaudeCliOptions = {
  /** Working directory of the `claude` process (the target repo, or a worktree). */
  cwd: string;
  model?: string;
  /** Run isolated from the user's settings, MCPs, skills and memory (DESIGN 4.3, 9). Default true. */
  isolated?: boolean;
  /** `dev.allowed_commands`: the only shell commands an editing run may use. */
  allowedCommands?: string[];
  /** Turn limit of a read-only call. Default 20. */
  maxTurns?: number;
  /** Time limit of a read-only call. Default 30 minutes. */
  timeoutMs?: number;
  /** Turn limit of an editing call (`dev.max_turns`). Not set: no limit. */
  editMaxTurns?: number;
  /** Time limit of an editing call (`dev.timeout_minutes`). Not set: no limit. */
  editTimeoutMs?: number;
  /** Called once if ANTHROPIC_API_KEY would replace the login (DESIGN 4.5). */
  notice?: (message: string) => void;
  /** Timers and time source. Default: the real ones. */
  clock?: Clock;
  /** Starts the process. Tests replace it; the default runs the real `claude`. */
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
};

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const EDIT_TOOLS = [...READ_ONLY_TOOLS, 'Edit', 'Write', 'Bash'];

export type Invocation = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
};

/**
 * Builds the `claude -p` call for one request. Pure, so the permission rules can be
 * tested without running the CLI.
 *
 * Read-only stages get `--tools Read,Grep,Glob`: `--tools` limits what exists, while
 * `--allowedTools` only pre-approves (DESIGN 9). Editing stages get file edits and only
 * the shell commands of `allowedCommands`. `bypassPermissions` is never used.
 */
export function buildInvocation(
  req: RunRequest,
  opts: ClaudeCliOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Invocation {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  const turns = req.canEdit ? opts.editMaxTurns : (opts.maxTurns ?? 20);
  if (turns !== undefined) args.push('--max-turns', String(turns));
  if (opts.model) args.push('--model', opts.model);

  args.push('--tools', (req.canEdit ? EDIT_TOOLS : READ_ONLY_TOOLS).join(','));
  const allowed = [...READ_ONLY_TOOLS];
  if (req.canEdit) {
    args.push('--permission-mode', 'acceptEdits');
    for (const cmd of opts.allowedCommands ?? [])
      allowed.push(`Bash(${cmd}:*)`);
  }
  args.push('--allowedTools', ...allowed);

  const env = { ...baseEnv };
  if (opts.isolated ?? true) {
    args.push(
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--disable-slash-commands',
    );
    env['CLAUDE_CODE_DISABLE_AUTO_MEMORY'] = '1';
  }

  const files =
    req.files.length > 0
      ? `Arquivos relevantes:\n${req.files.map((f) => `- ${f}`).join('\n')}\n\n`
      : '';
  return { args, env, stdin: `${files}${req.prompt}` };
}

/** Reads the final `result` event of a `stream-json` run. */
export function parseStream(output: string): string {
  let result: string | undefined;
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: {
      type?: string;
      subtype?: string;
      is_error?: boolean;
      result?: string;
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'result') continue;
    if (event.is_error || (event.subtype && event.subtype !== 'success')) {
      throw new ClaudeCliError(
        `o claude terminou com erro (${event.subtype ?? 'desconhecido'})`,
      );
    }
    result = event.result ?? '';
  }
  if (result === undefined)
    throw new ClaudeCliError('o claude não devolveu um resultado');
  return result;
}

/**
 * Reads one line of the `stream-json` output and returns the events it carries: the
 * model of `system`/`init` and the `tool_use` blocks of `assistant`. The model's text
 * and the tool results are never returned. Pure, so tests do not need the CLI.
 */
export function parseStreamEvents(line: string): RunnerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  let event: {
    type?: string;
    subtype?: string;
    model?: unknown;
    message?: { content?: unknown };
  };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return [];
  }
  if (event.type === 'system') {
    return event.subtype === 'init' &&
      typeof event.model === 'string' &&
      event.model.length > 0
      ? [{ type: 'model', model: event.model }]
      : [];
  }
  const content = event.message?.content;
  if (event.type !== 'assistant' || !Array.isArray(content)) return [];
  const events: RunnerEvent[] = [];
  for (const block of content as unknown[]) {
    const b = block as {
      type?: string;
      name?: unknown;
      input?: unknown;
    } | null;
    if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
    events.push({
      type: 'tool',
      name: b.name,
      arg: summarizeToolArg(b.name, b.input),
    });
  }
  return events;
}

export function createClaudeCliRunner(opts: ClaudeCliOptions): Runner {
  if (opts.notice && process.env['ANTHROPIC_API_KEY']) {
    opts.notice(
      'ANTHROPIC_API_KEY está definida: o claude usa a chave no lugar do login do Claude Code.',
    );
  }
  const start =
    opts.spawnFn ??
    ((cmd, args, o) =>
      spawn(cmd, args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));

  const clock = opts.clock ?? realClock;
  const limitFor = (canEdit: boolean) =>
    canEdit ? opts.editTimeoutMs : (opts.timeoutMs ?? 30 * 60_000);

  const runner: Runner = (req) =>
    new Promise<string>((resolve, reject) => {
      const { args, env, stdin } = buildInvocation(req, opts);
      const child = start('claude', args, { cwd: opts.cwd, env });
      let stdout = '';
      let stderr = '';
      let pending = '';
      // Set once the call ended (timeout, error or close): nothing more is reported.
      let settled = false;
      const emit = (line: string) => {
        if (settled || !req.onEvent) return;
        for (const e of parseStreamEvents(line)) req.onEvent(e);
      };
      let lastEventAt = clock.now();
      // True once an inactivity warning went out, until output shows up again.
      let warned = false;
      let cancelWatch = () => {};
      // Restarts the wait: no stream line for 2 minutes, then again every 5.
      const watch = () => {
        cancelWatch();
        if (!req.onEvent) return;
        const report = () => {
          warned = true;
          req.onEvent?.({
            type: 'inactivity',
            idleMs: clock.now() - lastEventAt,
          });
        };
        let cancelRepeat = () => {};
        const cancelFirst = clock.setTimeout(() => {
          report();
          cancelRepeat = clock.setInterval(report, INACTIVITY_REPEAT_MS);
        }, INACTIVITY_MS);
        cancelWatch = () => {
          cancelFirst();
          cancelRepeat();
        };
      };
      watch();
      const limit = limitFor(req.canEdit);
      const cancelTimer =
        limit === undefined
          ? () => {}
          : clock.setTimeout(() => {
              settled = true;
              cancelWatch();
              child.kill('SIGTERM');
              reject(
                new RunnerTimeoutError(
                  `o claude passou de ${limit} ms`,
                  limit,
                  stderr,
                ),
              );
            }, limit);

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (settled || !req.onEvent) return;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        if (lines.some((l) => l.trim())) {
          lastEventAt = clock.now();
          if (warned) {
            warned = false;
            req.onEvent({ type: 'activity' });
          }
          watch();
        }
        lines.forEach(emit);
      });
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        settled = true;
        cancelTimer();
        cancelWatch();
        reject(
          new ClaudeCliError(
            `não foi possível rodar o claude: ${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        cancelTimer();
        cancelWatch();
        emit(pending);
        settled = true;
        pending = '';
        try {
          resolve(parseStream(stdout));
        } catch (error) {
          const detail =
            code === 0
              ? ''
              : ` (código ${code}: ${maskSecrets(stderr.trim()).slice(0, 300)})`;
          reject(
            new ClaudeCliError(`${(error as Error).message}${detail}`, {
              stderr,
              exitCode: code,
            }),
          );
        }
      });
      child.stdin?.end(stdin);
    });
  runner.limitFor = limitFor;
  return runner;
}
