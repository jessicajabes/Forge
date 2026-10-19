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
};

/** Returns the text of the artifact produced. */
export type Runner = (req: RunRequest) => Promise<string>;
