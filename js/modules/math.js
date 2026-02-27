export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const toNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const dbToGain = (db) => Math.pow(10, db / 20);
