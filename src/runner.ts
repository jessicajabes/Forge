/** What a runner may report while it works, when the provider exposes it. */
export type RunnerEvent =
  | { type: 'model'; model: string }
  | { type: 'tool'; name: string; arg: string };

/** A failed runner call. Carries the CLI's full stderr and exit code for the reporter. */
export class RunnerError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(
    message: string,
    details: { stderr?: string; exitCode?: number | null } = {},
  ) {
    super(message);
    this.name = 'RunnerError';
    this.stderr = details.stderr ?? '';
    this.exitCode = details.exitCode ?? null;
  }
}

/** The call hit its time limit and the CLI was killed. */
export class RunnerTimeoutError extends RunnerError {
  readonly limitMs: number;
  constructor(message: string, limitMs: number, stderr = '') {
    super(message, { stderr });
    this.name = 'RunnerTimeoutError';
    this.limitMs = limitMs;
  }
}

/**
 * The only thing the orchestrator knows about a provider (DESIGN 4.2).
 * Each provider is a small file in `runners/` that returns a function of this type.
 */
export type RunRequest = {
  /** Instruction for the stage. */
  prompt: string;
  /** Files the agent may read. */
  files: string[];
  /** false = read-only, true = may edit the project. */
  canEdit: boolean;
  /** Optional: a runner that can tell its tools or real model calls this. */
  onEvent?: (event: RunnerEvent) => void;
};

/** Returns the text of the artifact produced. */
export type Runner = (req: RunRequest) => Promise<string>;

/**
 * Builds a Runner bound to a directory. The arena needs one per candidate worktree
 * (DESIGN 4.14); the request itself stays the same, so `Runner` does not change.
 */
export type RunnerFactory = (opts: {
  /** Where the agent works: the target repo or a worktree. */
  cwd: string;
  model?: string;
  runner?: 'claude-cli' | 'copilot-cli';
  /** The only shell commands an editing run may use. */
  allowedCommands?: string[];
}) => Runner;
