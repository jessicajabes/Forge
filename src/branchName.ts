const PREFIX = 'forge/';

const WORDS = [
  'aurora',
  'bambu',
  'cometa',
  'delta',
  'eclipse',
  'farol',
  'galaxia',
  'horizonte',
  'ilhota',
  'jacaranda',
  'kiwi',
  'lume',
  'maré',
  'nebulosa',
  'oasis',
  'pulsar',
  'quasar',
  'rio',
  'savana',
  'tundra',
  'umbra',
  'vento',
  'zenite',
  'brasa',
  'cedro',
  'duna',
  'ember',
  'fenix',
  'geada',
  'helice',
].map((word) => word.normalize('NFD').replace(/[̀-ͯ]/g, ''));

/** FNV-1a 32-bit hash: small, stable across processes and Node versions. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Picks `forge/<adjective>-<noun>` from a fixed local word list. Deterministic
 * for a run id, so a resumed run gets the same name. A name already present in
 * `existing` gets a numeric suffix.
 */
export function branchName(runId: string, existing: readonly string[]): string {
  const h = hash(runId);
  const first = WORDS[h % WORDS.length] ?? 'forge';
  const second = WORDS[Math.floor(h / WORDS.length) % WORDS.length] ?? 'run';
  const base = `${PREFIX}${first}-${second}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
