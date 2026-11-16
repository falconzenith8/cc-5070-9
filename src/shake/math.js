export const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep01(value, edge0 = 0, edge1 = 1) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const x = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

export function smootherstep01(value, edge0 = 0, edge1 = 1) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const x = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function degToRad(degrees) {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians) {
  return (radians * 180) / Math.PI;
}

export function hashSeed(seed, salt = '') {
  let h = (Math.floor(Number(seed) || 0) >>> 0) ^ 0x9e3779b9;
  const text = String(salt);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

export function deriveSeed(seed, salt = '') {
  return hashSeed(seed, salt);
}

export function mulberry32(state) {
  let a = state >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededUnit(seed, salt = '') {
  return mulberry32(deriveSeed(seed, salt))();
}

export function wrapAngle(radians) {
  const wrapped = ((radians + Math.PI) % TAU + TAU) % TAU;
  return wrapped - Math.PI;
}

export function angleBetweenQuaternions(a, b) {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(clamp(dot, 0, 1));
}
