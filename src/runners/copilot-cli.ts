import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRequest, Runner } from '../runner.js';

export class CopilotCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopilotCliError';
  }
}

export type CopilotCliOptions = {
  /** Working directory of the `copilot` process (the target repo, or a worktree). */
  cwd: string;
  model?: string;
  /** `dev.allowed_commands`: the only shell commands an editing run may use. */
  allowedCommands?: string[];
  timeoutMs?: number;
  /** Where `copilot` writes its usage statistics as JSON (`--usage-output-file`). */
  usageFile?: string;
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcess;
};

/** Never passed, whatever the config says (DESIGN 4.6). */
const FORBIDDEN_FLAGS = ['--allow-all', '--allow-all-tools', '--yolo'];

/**
 * The commands the Dev must never run. The prefix form `shell(<cmd>:*)` was tested in
 * DESIGN section 9 (T2): it blocks the command and its indirect forms.
 */
const ALWAYS_DENIED = ['git push', 'rm', 'curl', 'wget'];

/** The prompt goes in an argument. Past this size it goes to a file the agent reads. */
const MAX_PROMPT_BYTES = 100_000;

export type Invocation = { args: string[] };

/**
 * Builds the `copilot -p` call for one request. Pure, so the permission rules can be
 * tested without running the CLI. Read-only runs deny every write and shell tool.
 * Editing runs allow writing and only the listed shell commands, with an explicit deny
 * for `git push`, `rm`, `curl` and `wget`.
 */
export function buildInvocation(
  req: RunRequest,
  opts: CopilotCliOptions,
  prompt: string,
): Invocation {
  const args = [
    '-p',
    prompt,
    '-s',
    '--no-ask-user',
    '--no-custom-instructions',
    '--no-auto-update',
    '--disallow-temp-dir',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.usageFile) args.push('--usage-output-file', opts.usageFile);

  if (req.canEdit) {
    args.push('--allow-tool', 'write');
    for (const cmd of opts.allowedCommands ?? []) {
      if (
        ALWAYS_DENIED.some(
          (d) => cmd.trim() === d || cmd.trim().startsWith(`${d} `),
        )
      )
        continue;
      args.push('--allow-tool', `shell(${cmd})`);
    }
    for (const cmd of ALWAYS_DENIED)
      args.push('--deny-tool', `shell(${cmd}:*)`);
  } else {
    args.push('--deny-tool', 'write', '--deny-tool', 'shell');
  }

  for (const flag of FORBIDDEN_FLAGS) {
    if (args.includes(flag))
      throw new CopilotCliError(`a flag ${flag} nunca é usada pelo Forge`);
  }
  return { args };
}

export function createCopilotCliRunner(opts: CopilotCliOptions): Runner {
  const start =
    opts.spawnFn ??
    ((cmd, args, o) =>
      spawn(cmd, args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

  return async (req) => {
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
      const child = start('copilot', args, {
        cwd: opts.cwd,
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      const timeout = opts.timeoutMs ?? 30 * 60_000;
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new CopilotCliError(`o copilot passou de ${timeout} ms`));
      }, timeout);
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new CopilotCliError(
            `não foi possível rodar o copilot: ${error.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new CopilotCliError(
              `o copilot terminou com código ${code}: ${stderr.trim().slice(0, 300)}`,
            ),
          );
        } else if (stdout.trim() === '') {
          reject(new CopilotCliError('o copilot não devolveu texto'));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  };
}
