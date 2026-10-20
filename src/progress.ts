import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INACTIVITY_MS = 2 * 60 * 1000;
export const INACTIVITY_REPEAT_MS = 5 * 60 * 1000;
export const ARG_MAX_CHARS = 100;
export const STDERR_TAIL_LINES = 5;
export const STDERR_LINE_MAX_CHARS = 200;
export const PROGRESS_FILE = 'progress.jsonl';

export type ProgressEvent =
  | {
      type: 'call-start';
      id: string;
      label: string;
      runner: string;
      model: string | null;
      canEdit: boolean;
    }
  | {
      type: 'call-end';
      id: string;
      label: string;
      ok: boolean;
      ms: number;
      reason?: string;
      stderr?: string;
    }
  | { type: 'tool'; id: string; label: string; name: string; arg: string }
  | { type: 'model'; id: string; label: string; model: string }
  | { type: 'inactivity'; id: string; label: string; idleMs: number }
  | { type: 'timeout'; id: string; label: string; limitMs: number }
  | {
      type: 'stage';
      stage: string;
      phase: 'start' | 'end';
      index: number;
      total: number;
      ms?: number;
    }
  | {
      type: 'step';
      id: string;
      label: string;
      phase: 'start' | 'end';
      ok?: boolean;
      ms?: number;
    }
  | {
      type: 'worktree';
      id: string;
      label: string;
      action: 'create' | 'remove';
      phase: 'start' | 'end';
      ok?: boolean;
      ms?: number;
    };

export type TimedProgressEvent = ProgressEvent & { at: string };

export type ProgressWriter = (event: ProgressEvent) => Promise<void>;

function cut(text: string, max = ARG_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The main argument of a tool call, on one line and cut at ARG_MAX_CHARS: the path for
 * Read/Write/Edit, the pattern (and the path, if any) for Grep/Glob, the command for
 * Bash. Unknown tools give an empty string, so only their name is shown.
 */
export function summarizeToolArg(name: string, input: unknown): string {
  const args =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return cut(str(args.file_path) ?? str(args.path) ?? '');
    case 'Grep':
    case 'Glob': {
      const pattern = str(args.pattern);
      const path = str(args.path);
      if (pattern === undefined) return cut(path ?? '');
      return cut(path === undefined ? `"${pattern}"` : `"${pattern}" ${path}`);
    }
    case 'Bash':
      return cut(str(args.command) ?? '');
    default:
      return '';
  }
}

/**
 * Appends every event, with a timestamp, as one JSON line in progress.jsonl of the run
 * folder. It always writes, whatever is shown on the terminal, and never adds color.
 * A write failure is swallowed: progress must not break a run.
 */
export function createProgressWriter(
  runDir: string,
  now: () => Date = () => new Date(),
): ProgressWriter {
  const path = join(runDir, PROGRESS_FILE);
  return (event) => {
    const line: TimedProgressEvent = { at: now().toISOString(), ...event };
    return appendFile(path, `${JSON.stringify(line)}\n`).catch(() => undefined);
  };
}
