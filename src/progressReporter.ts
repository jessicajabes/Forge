import { RunnerError, RunnerTimeoutError } from './runner.js';
import type { RunnerEvent } from './runner.js';
import type { ProgressEvent, ProgressWriter } from './progress.js';
import { formatDuration, formatEvent, shouldStyle } from './progressFormat.js';

export type ProgressReporterOptions = {
  /** Writes every event to progress.jsonl. Always called, even when quiet. */
  write: ProgressWriter;
  /** Where the terminal lines go: stderr. */
  stream: { write(text: string): unknown; isTTY?: boolean };
  /** Turns off the terminal output only, never the progress.jsonl. */
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export type CallInfo = {
  id: string;
  label: string;
  runner: string;
  model: string | null;
  canEdit: boolean;
};

export type ProgressReporter = {
  /** Records one event and, unless quiet, prints its lines. */
  report(event: ProgressEvent): Promise<void>;
  /** Runs one agent call, reporting its start, tools, model, inactivity and end. */
  trackCall<T>(
    info: CallInfo,
    run: (onEvent: (event: RunnerEvent) => void) => Promise<T>,
  ): Promise<T>;
};

function failureReason(error: unknown): string {
  if (error instanceof RunnerTimeoutError) {
    return `encerrado por timeout após ${formatDuration(error.limitMs)}`;
  }
  if (error instanceof RunnerError && error.exitCode !== null) {
    return `código de saída ${error.exitCode}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/)[0] ?? message;
}

export function createProgressReporter(
  options: ProgressReporterOptions,
): ProgressReporter {
  const { write, stream, quiet = false, now = Date.now } = options;
  const styled = shouldStyle(stream, options.env);

  const report = async (event: ProgressEvent): Promise<void> => {
    await write(event);
    if (quiet) return;
    for (const line of formatEvent(event, styled)) {
      stream.write(line + '\n');
    }
  };

  const trackCall: ProgressReporter['trackCall'] = async (info, run) => {
    const started = now();
    const { id, label } = info;
    // Events arrive synchronously from the runner; keep their order on the way out.
    let pending: Promise<void> = report({ type: 'call-start', ...info });
    const queue = (event: ProgressEvent): void => {
      pending = pending.then(() => report(event));
    };
    const onEvent = (event: RunnerEvent): void => {
      switch (event.type) {
        case 'tool':
          queue({ type: 'tool', id, label, name: event.name, arg: event.arg });
          break;
        case 'model':
          queue({ type: 'model', id, label, model: event.model });
          break;
        case 'inactivity':
          queue({ type: 'inactivity', id, label, idleMs: event.idleMs });
          break;
      }
    };
    try {
      const output = await run(onEvent);
      queue({ type: 'call-end', id, label, ok: true, ms: now() - started });
      await pending;
      return output;
    } catch (error) {
      const ms = now() - started;
      if (error instanceof RunnerTimeoutError) {
        // The end line below already says it; this one only goes to progress.jsonl.
        const timeout: ProgressEvent = {
          type: 'timeout',
          id,
          label,
          limitMs: error.limitMs,
        };
        pending = pending.then(() => write(timeout));
      }
      queue({
        type: 'call-end',
        id,
        label,
        ok: false,
        ms,
        reason: failureReason(error),
        stderr: error instanceof RunnerError ? error.stderr : '',
      });
      await pending;
      throw error;
    }
  };

  return { report, trackCall };
}
