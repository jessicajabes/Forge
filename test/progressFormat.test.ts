import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatEvent,
  shouldStyle,
  stderrExcerpt,
} from '../src/progressFormat.js';
import type { ProgressEvent } from '../src/progress.js';

const ANSI = /\x1b\[/; // eslint-disable-line no-control-regex
const LABEL = 'dev · candidato 2 · claude-cli/sonnet';

const start: ProgressEvent = {
  type: 'call-start',
  id: 'c1',
  label: LABEL,
  runner: 'claude-cli',
  model: null,
  canEdit: true,
};
const endOk: ProgressEvent = {
  type: 'call-end',
  id: 'c1',
  label: LABEL,
  ok: true,
  ms: 130_000,
};
const endErr: ProgressEvent = {
  type: 'call-end',
  id: 'c1',
  label: LABEL,
  ok: false,
  ms: 5_000,
  reason: 'código de saída 1',
  stderr: 'boom',
};
const tool: ProgressEvent = {
  type: 'tool',
  id: 'c1',
  label: LABEL,
  name: 'Read',
  arg: 'src/x.ts',
};
const stageEnd: ProgressEvent = {
  type: 'stage',
  stage: 'dev',
  phase: 'end',
  index: 3,
  total: 7,
  ms: 4000,
};
const stepEnd: ProgressEvent = {
  type: 'step',
  id: 'build',
  label: 'npm test',
  phase: 'end',
  ok: true,
  ms: 42_000,
};

describe('shouldStyle', () => {
  it('is true only with a TTY and NO_COLOR undefined', () => {
    expect(shouldStyle({ isTTY: true }, {})).toBe(true);
    expect(shouldStyle({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(shouldStyle({ isTTY: false }, {})).toBe(false);
    expect(shouldStyle({}, {})).toBe(false);
    expect(shouldStyle({ isTTY: false }, { NO_COLOR: '1' })).toBe(false);
  });
});

describe('formatEvent with style (TTY, NO_COLOR unset)', () => {
  it('paints the prefix gray, ok green and shows symbols', () => {
    const [startLine] = formatEvent(start, true);
    expect(startLine).toContain(`\x1b[90m[${LABEL}]\x1b[0m`);
    expect(startLine).toContain('▶');
    expect(startLine).toContain('padrão do CLI');
    expect(startLine).toContain('edição');
    const [okLine] = formatEvent(endOk, true);
    expect(okLine).toContain('\x1b[32m✓ ok\x1b[0m');
    expect(okLine).toContain('2m10s');
  });

  it('paints error and timeout red, inactivity yellow', () => {
    const [errLine] = formatEvent(endErr, true);
    expect(errLine).toContain('\x1b[31m✗ erro\x1b[0m');
    expect(errLine).toContain('código de saída 1');
    const [timeout] = formatEvent(
      { type: 'timeout', id: 'c1', label: LABEL, limitMs: 30 * 60_000 },
      true,
    );
    expect(timeout).toContain('\x1b[31m');
    expect(timeout).toContain('encerrado por timeout após 30m');
    const [idle] = formatEvent(
      { type: 'inactivity', id: 'c1', label: LABEL, idleMs: 120_000 },
      true,
    );
    expect(idle).toContain('\x1b[33m');
    expect(idle).toContain('⏳');
    expect(idle).toContain('sem atividade há 2m');
  });
});

describe('formatEvent as plain text (no TTY or NO_COLOR set)', () => {
  const events: ProgressEvent[] = [
    start,
    endOk,
    endErr,
    tool,
    { type: 'model', id: 'c1', label: LABEL, model: 'claude-sonnet-5-5' },
    { type: 'inactivity', id: 'c1', label: LABEL, idleMs: 120_000 },
    { type: 'timeout', id: 'c1', label: LABEL, limitMs: 60_000 },
    { type: 'stage', stage: 'dev', phase: 'start', index: 3, total: 7 },
    stageEnd,
    { type: 'step', id: 'build', label: 'npm test', phase: 'start' },
    stepEnd,
  ];

  it('has no ANSI codes and no symbols', () => {
    for (const line of events.flatMap((e) => formatEvent(e, false))) {
      expect(line).not.toMatch(ANSI);
      expect(line).not.toMatch(/[▶✓✗⏳]/u);
    }
  });

  it('writes ok and erro in words', () => {
    expect(formatEvent(endOk, false)[0]).toBe(`[${LABEL}] ok em 2m10s`);
    expect(formatEvent(endErr, false)[0]).toBe(
      `[${LABEL}] erro em 5s: código de saída 1`,
    );
    expect(formatEvent(stageEnd, false)[0]).toBe('etapa dev (3/7) em 4s');
    expect(formatEvent(stepEnd, false)[0]).toBe('[build] ok em 42s');
  });

  it('shows the tool name with its argument', () => {
    expect(formatEvent(tool, false)[0]).toBe(`[${LABEL}] Read src/x.ts`);
  });
});

describe('stderr excerpt', () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n');

  it('keeps everything with fewer than 5 lines', () => {
    expect(stderrExcerpt(lines(3))).toEqual(['l1', 'l2', 'l3']);
  });

  it('keeps all of exactly 5 lines', () => {
    expect(stderrExcerpt(lines(5))).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
  });

  it('is empty for empty stderr', () => {
    expect(stderrExcerpt('')).toEqual([]);
    expect(
      formatEvent({ ...endErr, stderr: '' } as ProgressEvent, false),
    ).toHaveLength(1);
  });

  it('keeps at most 5 lines, the last ones, and cuts each at 200 characters', () => {
    const stderr = Array.from(
      { length: 8 },
      (_, i) => `l${i + 1}${'x'.repeat(300)}`,
    ).join('\n');
    const excerpt = stderrExcerpt(stderr);
    expect(excerpt).toHaveLength(5);
    expect(excerpt[0]?.startsWith('l4')).toBe(true);
    expect(excerpt[4]?.startsWith('l8')).toBe(true);
    for (const line of excerpt) expect(line.length).toBeLessThanOrEqual(200);
  });

  it('does not cut a line of exactly 200 characters', () => {
    const line = 'y'.repeat(200);
    expect(stderrExcerpt(line)).toEqual([line]);
  });

  it('is indented and prefixed in the error end event, and only there', () => {
    const out = formatEvent(
      { ...endErr, stderr: 'a\nb\nc\nd\ne\nf\ng' } as ProgressEvent,
      false,
    );
    expect(out).toHaveLength(1 + 5);
    expect(out[1]).toBe(`  [${LABEL}] c`);
    expect(formatEvent(endOk, false)).toHaveLength(1);
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(130_000)).toBe('2m10s');
    expect(formatDuration(30 * 60_000)).toBe('30m');
    expect(formatDuration(3_600_000)).toBe('1h');
  });
});
