import { clamp } from './math.js';

export function quatIdentity() {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function quatMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatFromAxisAngle(axis, angle) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** Rotation order YXZ, matching three.js camera Euler semantics. */
export function quatFromEulerYXZ(pitch, yaw, roll) {
  const qx = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch);
  const qy = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
  const qz = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, roll);
  return quatMultiply(quatMultiply(qy, qx), qz);
}

export function quatRotateVector(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export function quatAngle(a, b) {
  // Relative rotation angle via atan2; stable near identity where acos loses
  // precision. a and b are assumed unit quaternions (or uniformly scaled).
  const ax = -a.x;
  const ay = -a.y;
  const az = -a.z;
  const aw = a.w;
  const rx = aw * b.x + ax * b.w + ay * b.z - az * b.y;
  const ry = aw * b.y - ax * b.z + ay * b.w + az * b.x;
  const rz = aw * b.z + ax * b.y - ay * b.x + az * b.w;
  const rw = aw * b.w - ax * b.x - ay * b.y - az * b.z;
  return 2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw));
}

/**
 * Inverse of quatFromEulerYXZ for R = Ry(yaw) · Rx(pitch) · Rz(roll):
 *   R = [ cy·cr + sy·sp·sr,  -cy·sr + sy·sp·cr,  sy·cp ]
 *       [ cp·sr,              cp·cr,             -sp   ]
 *       [ -sy·cr + cy·sp·sr,  sy·sr + cy·sp·cr,  cy·cp ]
 * so pitch = asin(-R12), yaw = atan2(R02, R22), roll = atan2(R10, R11).
 */
export function quatToEulerYXZ(q) {
  const { x, y, z, w } = q;
  const r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const pitch = Math.asin(clamp(-r12, -1, 1));
  const yaw = Math.atan2(r02, r22);
  const roll = Math.atan2(r10, r11);
  return { pitch, yaw, roll };
}
