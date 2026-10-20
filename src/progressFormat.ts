import {
  ARG_MAX_CHARS,
  STDERR_LINE_MAX_CHARS,
  STDERR_TAIL_LINES,
  type ProgressEvent,
} from './progress.js';

const RESET = '\x1b[0m';
const GRAY = '\x1b[90m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const DEFAULT_MODEL = 'padrão do CLI';

/** Colors and symbols only when stderr is a TTY and NO_COLOR is not defined. */
export function shouldStyle(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined;
}

// Both patterns match control characters on purpose: that is what they strip.
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g; // eslint-disable-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/g; // eslint-disable-line no-control-regex

/**
 * Text that came from an agent or the target repo can carry escape sequences or \r that
 * would fake a status line or move the cursor. Drop them before anything reaches the TTY.
 */
export function clean(text: string): string {
  return text.replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARS, '');
}

function paint(color: string, text: string, styled: boolean): string {
  return styled ? `${color}${text}${RESET}` : text;
}

function prefix(label: string, styled: boolean): string {
  return paint(GRAY, `[${clean(label)}]`, styled);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function cutLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last STDERR_TAIL_LINES non-empty lines, each cut at STDERR_LINE_MAX_CHARS. */
export function stderrExcerpt(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => clean(line).trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-STDERR_TAIL_LINES)
    .map((line) => cutLine(line, STDERR_LINE_MAX_CHARS));
}

function result(ok: boolean | undefined, styled: boolean): string {
  if (ok === false) return paint(RED, styled ? '✗ erro' : 'erro', styled);
  return paint(GREEN, styled ? '✓ ok' : 'ok', styled);
}

function withDuration(head: string, ms: number | undefined): string {
  return ms === undefined ? head : `${head} em ${formatDuration(ms)}`;
}

/** The terminal lines for one event, without newline. Pure: no I/O, no clock. */
export function formatEvent(event: ProgressEvent, styled: boolean): string[] {
  switch (event.type) {
    case 'call-start': {
      const mode = event.canEdit ? 'edição' : 'só leitura';
      const model = event.model ?? DEFAULT_MODEL;
      const start = styled ? '▶ ' : '';
      return [
        `${prefix(event.label, styled)} ${start}${clean(event.runner)} · modelo: ${clean(model)} · ${mode}`,
      ];
    }
    case 'call-end': {
      const head = withDuration(result(event.ok, styled), event.ms);
      const reason =
        event.ok || !event.reason ? '' : `: ${clean(event.reason)}`;
      const lines = [`${prefix(event.label, styled)} ${head}${reason}`];
      if (!event.ok && event.stderr) {
        for (const line of stderrExcerpt(event.stderr)) {
          lines.push(`  ${prefix(event.label, styled)} ${line}`);
        }
      }
      return lines;
    }
    case 'tool': {
      const name = cutLine(clean(event.name), ARG_MAX_CHARS);
      const arg = clean(event.arg);
      const text = arg ? `${name} ${arg}` : name;
      return [`${prefix(event.label, styled)} ${text}`];
    }
    case 'model':
      return [`${prefix(event.label, styled)} modelo: ${clean(event.model)}`];
    case 'inactivity': {
      const text = `${styled ? '⏳ ' : ''}sem atividade há ${formatDuration(event.idleMs)}`;
      return [`${prefix(event.label, styled)} ${paint(YELLOW, text, styled)}`];
    }
    case 'activity':
      return [`${prefix(event.label, styled)} voltou a ter atividade`];
    case 'timeout': {
      const text = `${styled ? '✗ ' : ''}encerrado por timeout após ${formatDuration(event.limitMs)}`;
      return [`${prefix(event.label, styled)} ${paint(RED, text, styled)}`];
    }
    case 'stage': {
      const name = `etapa ${event.stage} (${event.index}/${event.total})`;
      if (event.phase === 'start') {
        return [paint(GRAY, `${styled ? '▶ ' : ''}${name}`, styled)];
      }
      if (event.ok === false) {
        const reason = event.reason ? `: ${clean(event.reason)}` : '';
        return [
          `${name} ${withDuration(result(false, styled), event.ms)}${reason}`,
        ];
      }
      const done = styled ? `${paint(GREEN, '✓', styled)} ` : '';
      return [`${done}${withDuration(name, event.ms)}`];
    }
    case 'step':
    case 'worktree': {
      const head = prefix(event.id, styled);
      if (event.phase === 'start') {
        return [`${head} ${styled ? '▶ ' : ''}${clean(event.label)}`];
      }
      return [`${head} ${withDuration(result(event.ok, styled), event.ms)}`];
    }
  }
}
