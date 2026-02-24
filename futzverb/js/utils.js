// utils.js — small helpers shared across modules

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const toNumber = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const dbToGain = (db) => Math.pow(10, db / 20);

export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));
