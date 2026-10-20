import { appendFile } from 'node:fs/promises';
import type { RunnerFactory, RunRequest } from './runner.js';

export type CallRecord = {
  at: string;
  runner: string;
  model: string | null;
  canEdit: boolean;
  promptChars: number;
  outputChars: number;
  ms: number;
  ok: boolean;
};

/**
 * Wraps a runner factory so every model call is appended to a JSON Lines file. The CLIs
 * do not report real cost, so the number of calls and the size of what went in and out
 * are the relative measure of DESIGN 4.10. The prompts themselves are never written.
 */
export function logCalls(factory: RunnerFactory, path: string): RunnerFactory {
  return (opts) => {
    const runner = factory(opts);
    return async (req) => {
      const started = Date.now();
      let realModel: string | undefined;
      const onEvent: NonNullable<RunRequest['onEvent']> = (event) => {
        if (event.type === 'model') realModel = event.model;
        req.onEvent?.(event);
      };
      const record = (ok: boolean, output: string): Promise<void> => {
        const line: CallRecord = {
          at: new Date().toISOString(),
          runner: opts.runner ?? 'claude-cli',
          model: realModel ?? opts.model ?? null,
          canEdit: req.canEdit,
          promptChars: req.prompt.length,
          outputChars: output.length,
          ms: Date.now() - started,
          ok,
        };
        return appendFile(path, `${JSON.stringify(line)}\n`).catch(
          () => undefined,
        );
      };
      try {
        const output = await runner({ ...req, onEvent });
        await record(true, output);
        return output;
      } catch (error) {
        await record(false, '');
        throw error;
      }
    };
  };
}
