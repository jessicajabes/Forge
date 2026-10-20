import { RunnerError, RunnerTimeoutError } from './runner.js';
import type { RunnerEvent } from './runner.js';
import type { ProgressEvent, ProgressWriter } from './progress.js';
import { formatDuration, formatEvent, shouldStyle } from './progressFormat.js';

export type ProgressReporterOptions = {
  /** Writes every event to progress.jsonl. Always called, even when quiet. */
  write: ProgressWriter;
  /** Where the terminal lines go: stderr. */
  stream: {
    write(text: string): unknown;
    isTTY?: boolean;
    columns?: number;
  };
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
  /** The timeout of the call, shown in the footer as elapsed/limit. */
  limitMs?: number;
};

export type ProgressReporter = {
  /** Records one event and, unless quiet, prints its lines. */
  report(event: ProgressEvent): Promise<void>;
  /** Runs one agent call, reporting its start, tools, model, inactivity and end. */
  trackCall<T>(
    info: CallInfo,
    run: (onEvent: (event: RunnerEvent) => void) => Promise<T>,
  ): Promise<T>;
  /** Erases the footer and keeps it off, so a readline prompt is not trampled. */
  pauseFooter(): void;
  /** Lets the footer be drawn again after the answer. */
  resumeFooter(): void;
};

type Running = {
  label: string;
  started: number;
  limitMs?: number;
  idleSince?: number;
};

const FOOTER_REFRESH_MS = 1000;
const FOOTER_SEPARATOR = ' │ ';
const ERASE_LINE = '\r\x1b[2K';
const GRAY = '\x1b[90m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

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
  // The footer rewrites the line in place, so it exists only where the lines are styled.
  const footerOn = styled && !quiet;
  const running = new Map<string, Running>();
  let paused = 0;
  let footerShown = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const footerText = (): string => {
    const max = (stream.columns ?? 80) - 1;
    const parts: string[] = [];
    let used = 0;
    for (const entry of running.values()) {
      const elapsed = formatDuration(now() - entry.started);
      const time =
        entry.limitMs === undefined
          ? elapsed
          : `${elapsed}/${formatDuration(entry.limitMs)}`;
      const idle =
        entry.idleSince === undefined
          ? ''
          : ` · sem atividade há ${formatDuration(now() - entry.idleSince)}`;
      const head = `${entry.label} ${time}`;
      const cost =
        head.length +
        idle.length +
        (parts.length > 0 ? FOOTER_SEPARATOR.length : 0);
      if (used + cost > max) {
        // Never wrap: a wrapped footer could not be erased with one carriage return.
        parts.push(parts.length === 0 ? `${head.slice(0, max - 1)}…` : '…');
        break;
      }
      used += cost;
      parts.push(idle ? `${head}${YELLOW}${idle}${GRAY}` : head);
    }
    return parts.join(FOOTER_SEPARATOR);
  };

  const erase = (): void => {
    if (!footerShown) return;
    stream.write(ERASE_LINE);
    footerShown = false;
  };

  const draw = (): void => {
    if (!footerOn || paused > 0 || running.size === 0) return;
    stream.write(`${ERASE_LINE}${GRAY}${footerText()}${RESET}`);
    footerShown = true;
  };

  const track = (event: ProgressEvent): void => {
    switch (event.type) {
      case 'call-start':
        if (!running.has(event.id)) {
          running.set(event.id, { label: event.label, started: now() });
        }
        break;
      case 'tool':
      case 'model': {
        const entry = running.get(event.id);
        if (entry) delete entry.idleSince;
        break;
      }
      case 'inactivity': {
        const entry = running.get(event.id);
        if (entry) entry.idleSince = now() - event.idleMs;
        break;
      }
      case 'call-end':
        running.delete(event.id);
        break;
      case 'step':
      case 'worktree': {
        const key = `${event.type}:${event.id}`;
        if (event.phase === 'start') {
          running.set(key, {
            label: `${event.id} ${event.label}`,
            started: now(),
          });
        } else {
          running.delete(key);
        }
        break;
      }
    }
    if (running.size > 0 && timer === null) {
      timer = setInterval(draw, FOOTER_REFRESH_MS);
      timer.unref();
    } else if (running.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const report = async (event: ProgressEvent): Promise<void> => {
    await write(event);
    if (quiet) return;
    erase();
    for (const line of formatEvent(event, styled)) {
      stream.write(line + '\n');
    }
    if (footerOn) {
      track(event);
      draw();
    }
  };

  const trackCall: ProgressReporter['trackCall'] = async (info, run) => {
    const started = now();
    const { limitMs, ...startInfo } = info;
    const { id, label } = info;
    if (footerOn) {
      running.set(id, {
        label,
        started,
        ...(limitMs !== undefined ? { limitMs } : {}),
      });
    }
    // Events arrive synchronously from the runner; keep their order on the way out.
    let pending: Promise<void> = report({ type: 'call-start', ...startInfo });
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

  const pauseFooter = (): void => {
    paused += 1;
    erase();
  };

  const resumeFooter = (): void => {
    paused = Math.max(0, paused - 1);
    draw();
  };

  return { report, trackCall, pauseFooter, resumeFooter };
}
