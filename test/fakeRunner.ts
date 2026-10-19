import type { RunRequest, Runner } from '../src/runner.js';

export type FakeResponse =
  string | ((req: RunRequest) => string | Promise<string>);

export type FakeRunner = {
  runner: Runner;
  /** Every request received, in order. */
  calls: RunRequest[];
};

/**
 * A Runner that returns canned responses in order and records the calls.
 * Fails loudly when the script runs out, so a test never silently under-specifies.
 */
export function createFakeRunner(responses: FakeResponse[]): FakeRunner {
  const calls: RunRequest[] = [];
  let next = 0;
  const runner: Runner = async (req) => {
    calls.push(req);
    const response = responses[next++];
    if (response === undefined) {
      throw new Error(`FakeRunner: no response left for call #${calls.length}`);
    }
    return typeof response === 'function' ? response(req) : response;
  };
  return { runner, calls };
}
