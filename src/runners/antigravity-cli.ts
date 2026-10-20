import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RunnerError,
  RunnerTimeoutError,
  type RunRequest,
  type Runner,
} from '../runner.js';

export class AntigravityCliError extends RunnerError {
  constructor(
    message: string,
    details: { stderr?: string; exitCode?: number | null } = {},
  ) {
    super(message, details);
    this.name = 'AntigravityCliError';
  }
}

export type AntigravityCliOptions = {
  /** Working directory of the `agy` process (the target repo, or a worktree). */
  cwd: string;
  model?: string;
  /** Time limit of a read-only call. Default 30 minutes. */
  timeoutMs?: number;
  /** Time limit of an editing call (`dev.timeout_minutes`). Not set: no limit. */
  editTimeoutMs?: number;
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
};

/** The prompt goes in an argument. Past this size it goes to a file the agent reads. */
const MAX_PROMPT_BYTES = 100_000;

/**
 * Builds the `agy -p` call for one request. Pure, so the permission rules can be
 * tested without running the CLI. Read-only runs use `plan` mode. Editing runs use
 * `accept-edits`: file edits are approved, shell commands are not, so
 * `dev.allowed_commands` does not apply to this runner.
 * `--dangerously-skip-permissions` is never passed.
 */
export function buildInvocation(
  req: RunRequest,
  opts: AntigravityCliOptions,
  prompt: string,
): { args: string[] } {
  const args = ['-p', prompt, '--mode', req.canEdit ? 'accept-edits' : 'plan'];
  if (opts.model) args.push('--model', opts.model);
  return { args };
}

export function createAntigravityCliRunner(
  opts: AntigravityCliOptions,
): Runner {
  const start =
    opts.spawnFn ??
    ((cmd, args, o) =>
      spawn(cmd, args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

  const limitFor = (canEdit: boolean) =>
    canEdit ? opts.editTimeoutMs : (opts.timeoutMs ?? 30 * 60_000);

  const runner: Runner = async (req) => {
    const files =
      req.files.length > 0
        ? `Arquivos relevantes:\n${req.files.map((f) => `- ${f}`).join('\n')}\n\n`
        : '';
    let prompt = `${files}${req.prompt}`;
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) {
      // Too long for an argument: put it in a file inside the working directory.
      const dir = join(opts.cwd, '.workflow', 'prompts');
      await mkdir(dir, { recursive: true });
      const file = join(
        dir,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
      );
      await writeFile(file, prompt);
      prompt = `Read the file ${file} and follow the instructions in it exactly. Reply as that file asks.`;
    }
    const { args } = buildInvocation(req, opts, prompt);

    return new Promise<string>((resolve, reject) => {
      const child = start('agy', args, {
        cwd: opts.cwd,
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      const timeout = limitFor(req.canEdit);
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              child.kill('SIGTERM');
              reject(
                new RunnerTimeoutError(
                  `o agy passou de ${timeout} ms`,
                  timeout,
                  stderr,
                ),
              );
            }, timeout);
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new AntigravityCliError(
            `não foi possível rodar o agy: ${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new AntigravityCliError(
              `o agy terminou com código ${code}: ${stderr.trim().slice(0, 300)}`,
              { stderr, exitCode: code },
            ),
          );
        } else if (stdout.trim() === '') {
          reject(
            new AntigravityCliError('o agy não devolveu texto', {
              stderr,
              exitCode: code,
            }),
          );
        } else {
          resolve(stdout.trim());
        }
      });
    });
  };
  runner.limitFor = limitFor;
  return runner;
}
