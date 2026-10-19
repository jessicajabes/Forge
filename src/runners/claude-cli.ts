import { spawn, type ChildProcess } from 'node:child_process';
import type { RunRequest, Runner } from '../runner.js';

export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

export type ClaudeCliOptions = {
  /** Working directory of the `claude` process (the target repo, or a worktree). */
  cwd: string;
  model?: string;
  /** Run isolated from the user's settings, MCPs, skills and memory (DESIGN 4.3, 9). Default true. */
  isolated?: boolean;
  /** `dev.allowed_commands`: the only shell commands an editing run may use. */
  allowedCommands?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  /** Called once if ANTHROPIC_API_KEY would replace the login (DESIGN 4.5). */
  notice?: (message: string) => void;
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
  args.push('--max-turns', String(opts.maxTurns ?? (req.canEdit ? 60 : 20)));
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

  return (req) =>
    new Promise<string>((resolve, reject) => {
      const { args, env, stdin } = buildInvocation(req, opts);
      const child = start('claude', args, { cwd: opts.cwd, env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(
        () => {
          child.kill('SIGTERM');
          reject(
            new ClaudeCliError(
              `o claude passou de ${opts.timeoutMs ?? 30 * 60_000} ms`,
            ),
          );
        },
        opts.timeoutMs ?? 30 * 60_000,
      );

      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new ClaudeCliError(
            `não foi possível rodar o claude: ${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          resolve(parseStream(stdout));
        } catch (error) {
          const detail =
            code === 0
              ? ''
              : ` (código ${code}: ${stderr.trim().slice(0, 300)})`;
          reject(new ClaudeCliError(`${(error as Error).message}${detail}`));
        }
      });
      child.stdin?.end(stdin);
    });
}
