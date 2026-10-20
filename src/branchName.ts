const PREFIX = 'forge/';

const ADJECTIVES = [
  'agil',
  'bravo',
  'calmo',
  'dourado',
  'esperto',
  'feliz',
  'gentil',
  'habil',
  'inquieto',
  'jovem',
  'leve',
  'macio',
  'nobre',
  'otimo',
  'pacato',
  'quieto',
  'rapido',
  'sereno',
  'tenaz',
  'unico',
];

const NOUNS = [
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
  'lume',
  'mare',
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
  'fenix',
  'geada',
  'helice',
];

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
  const first = ADJECTIVES[h % ADJECTIVES.length] ?? 'forge';
  const second =
    NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length] ?? 'run';
  const base = `${PREFIX}${first}-${second}`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
