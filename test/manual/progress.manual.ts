import { closeSync, createReadStream, openSync } from 'node:fs';
import { WriteStream } from 'node:tty';
import { describe, expect, it } from 'vitest';
import { createReadlineIO } from '../../src/io.js';
import type { ProgressEvent } from '../../src/progress.js';
import { createProgressReporter } from '../../src/progressReporter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The live footer is drawn in place, so only a person can judge it. Run it from a real
 * terminal (it talks to /dev/tty, so vitest's piped stdio does not matter):
 *
 *   npx vitest run --config vitest.manual.config.ts progress
 *
 * What you should see:
 *  1. Two calls and a build step run for about 20s. One footer line is rewritten in place
 *     with `elapsed/limit` for each, and tool lines scroll above it without leaving
 *     footer copies behind.
 *  2. After ~6s the question "Continuar? " appears. The footer is gone while it waits and
 *     the prompt is intact. Type something and press Enter.
 *  3. The footer comes back after the answer, and the third call shows
 *     `· sem atividade há 2m` in yellow.
 *  4. When everything ends the footer disappears and the last line is the `ok` of the step.
 */
describe('progress footer (real terminal)', () => {
  it('redraws in place and stays out of the readline prompt', async () => {
    let fd: number;
    try {
      fd = openSync('/dev/tty', 'r+');
    } catch {
      console.warn('no /dev/tty: run this from a terminal');
      return;
    }
    const out = new WriteStream(fd);
    const input = createReadStream('', { fd, autoClose: false });
    const events: ProgressEvent[] = [];
    const reporter = createProgressReporter({
      write: async (event) => {
        events.push(event);
      },
      stream: out,
    });
    const io = createReadlineIO(input, out);
    io.setAskHooks?.({
      before: () => reporter.pauseFooter(),
      after: () => reporter.resumeFooter(),
    });

    const base = { runner: 'claude-cli', model: null, canEdit: false };
    const calls = [
      reporter.trackCall(
        { ...base, id: 'c1', label: 'dev · candidato 1', limitMs: 30 * 60_000 },
        async (onEvent) => {
          for (const arg of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
            await sleep(4000);
            onEvent({ type: 'tool', name: 'Read', arg });
          }
          await sleep(8000);
        },
      ),
      reporter.trackCall(
        { ...base, id: 'c2', label: 'dev · candidato 2', limitMs: 30 * 60_000 },
        async (onEvent) => {
          await sleep(10_000);
          onEvent({ type: 'inactivity', idleMs: 2 * 60_000 });
          await sleep(8000);
        },
      ),
    ];
    await reporter.report({
      type: 'step',
      id: 'build',
      label: 'npm test',
      phase: 'start',
    });
    await sleep(6000);
    const answer = await io.ask('Continuar? ');
    await Promise.all(calls);
    await reporter.report({
      type: 'step',
      id: 'build',
      label: 'npm test',
      phase: 'end',
      ok: true,
      ms: 20_000,
    });

    io.close();
    out.write(`\nresposta: ${answer}\n`);
    closeSync(fd);
    expect(events.some((e) => e.type === 'call-end')).toBe(true);
  });
});
