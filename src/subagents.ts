import type { Runner } from './runner.js';

export type SubagentSpec = {
  /** Names the subagent in results and in the stage's artifact. */
  id: string;
  prompt: string;
  files?: string[];
  /** Throws when the output is malformed; the Forge then asks again (DESIGN 4.1). */
  validate?: (text: string) => unknown;
};

export type SubagentResult =
  | { id: string; ok: true; text: string; attempts: number }
  | { id: string; ok: false; error: string; attempts: number };

export type SubagentOptions = {
  /** `subagents.max_parallel`. */
  maxParallel: number;
  /** Failures in a row before giving up on one subagent. The design rule is three. */
  maxAttempts?: number;
};

/** Raised by `assertAllOk` when a subagent used up its attempts: escalate to the human. */
export class SubagentEscalation extends Error {
  constructor(
    public readonly failed: Extract<SubagentResult, { ok: false }>[],
    /** What the other subagents already returned, so it is not lost. */
    public readonly completed: Extract<SubagentResult, { ok: true }>[],
  ) {
    super(
      `subagente(s) sem resposta válida após as tentativas: ${failed.map((f) => f.id).join(', ')}`,
    );
    this.name = 'SubagentEscalation';
  }
}

async function runOne(
  runner: Runner,
  spec: SubagentSpec,
  maxAttempts: number,
): Promise<SubagentResult> {
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryNote =
      attempt === 1
        ? ''
        : `\n\nA resposta anterior foi inválida (${lastError}). Responda de novo, no formato pedido.`;
    try {
      // A subagent only reads: never an editing run, whatever the stage (DESIGN 4.13).
      const text = await runner({
        prompt: spec.prompt + retryNote,
        files: spec.files ?? [],
        canEdit: false,
      });
      spec.validate?.(text);
      return { id: spec.id, ok: true, text, attempts: attempt };
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  return { id: spec.id, ok: false, error: lastError, attempts: maxAttempts };
}

/**
 * Runs isolated, read-only runner calls in parallel, at most `maxParallel` at a time.
 * A subagent that fails never takes down the others: every result comes back, in the
 * order of `specs`. Use `assertAllOk` to turn a failure into an escalation.
 */
export async function runSubagents(
  runner: Runner,
  specs: SubagentSpec[],
  options: SubagentOptions,
): Promise<SubagentResult[]> {
  const maxAttempts = options.maxAttempts ?? 3;
  const results = new Array<SubagentResult>(specs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const spec = specs[index];
      if (!spec) return;
      results[index] = await runOne(runner, spec, maxAttempts);
    }
  };
  const width = Math.max(1, Math.min(options.maxParallel, specs.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

export function assertAllOk(
  results: SubagentResult[],
): Extract<SubagentResult, { ok: true }>[] {
  const failed = results.filter(
    (r): r is Extract<SubagentResult, { ok: false }> => !r.ok,
  );
  const completed = results.filter(
    (r): r is Extract<SubagentResult, { ok: true }> => r.ok,
  );
  if (failed.length > 0) throw new SubagentEscalation(failed, completed);
  return completed;
}
