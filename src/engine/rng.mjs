// Seeded pseudo-random numbers. mulberry32 uses only 32-bit integer maths
// (Math.imul and unsigned shifts), so Node and every browser produce the
// same sequence for the same seed.

export function makeRng(seed) {
  let a = hashSeed(seed) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Accepts a number or a string; strings are hashed (FNV-1a) so a claim id
// can seed its own sweep without disturbing the main run.
export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Poisson sample (Knuth) for small means; normal approximation for large ones.
export function poisson(rng, mean) {
  if (mean <= 0) return 0;
  if (mean > 50) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * z));
  }
  const L = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
