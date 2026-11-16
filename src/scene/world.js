import * as THREE from 'three';

const PALETTE = {
  fog: 0x080d14,
  floor: 0x111a24,
  concrete: 0x1a2733,
  steel: 0x293b4b,
  accent: 0x28d7e0,
  amber: 0xffb347,
  target: 0xe8f1f7,
};

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.25,
    ...options,
  });
}

/**
 * Builds a static test range. Nothing in this scene moves: all apparent
 * motion in the viewport comes from the render camera's final transform.
 */
export function createWorld() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.fog);
  scene.fog = new THREE.Fog(PALETTE.fog, 14, 46);

  const group = new THREE.Group();
  group.name = 'StaticRange';
  scene.add(group);

  const hemi = new THREE.HemisphereLight(0xa8c7dd, 0x0a0f15, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xdfefff, 2.1);
  key.position.set(6, 12, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 50;
  key.shadow.camera.left = -18;
  key.shadow.camera.right = 18;
  key.shadow.camera.top = 18;
  key.shadow.camera.bottom = -18;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x3f7fff, 0.7);
  rim.position.set(-8, 4, -10);
  scene.add(rim);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120, 1, 1), material(PALETTE.floor, { roughness: 0.9, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const grid = new THREE.GridHelper(120, 120, 0x2d4b5f, 0x172733);
  grid.position.y = 0.011;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  group.add(grid);

  const laneMat = material(PALETTE.accent, { emissive: PALETTE.accent, emissiveIntensity: 0.55, roughness: 0.4 });
  for (const x of [-3.1, 3.1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 26), laneMat);
    strip.position.set(x, 0.03, -9);
    group.add(strip);
  }

  const pillarMat = material(PALETTE.concrete, { roughness: 0.78 });
  const capMat = material(PALETTE.steel, { roughness: 0.35, metalness: 0.6 });
  for (let i = 0; i < 7; i++) {
    const z = -1.5 - i * 3.6;
    for (const side of [-1, 1]) {
      const x = side * (5.2 + (i % 2) * 0.4);
      const height = 5.4 + (i % 3) * 0.9;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.72, height, 0.72), pillarMat);
      pillar.position.set(x, height / 2, z);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      group.add(pillar);

      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.16, 0.98), capMat);
      cap.position.set(x, height + 0.08, z);
      cap.castShadow = true;
      group.add(cap);

      const band = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.08, 0.76), laneMat);
      band.position.set(x, height * 0.62, z);
      group.add(band);
    }
  }

  // Near-field bollards: strong parallax cues that expose camera translation.
  const bollardMat = material(PALETTE.amber, { emissive: PALETTE.amber, emissiveIntensity: 0.18, roughness: 0.5 });
  for (const [x, z, h] of [[-1.7, 3.4, 1.15], [1.9, 3.9, 0.95], [-2.35, 5.1, 0.7]]) {
    const bollard = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, h, 18), bollardMat);
    bollard.position.set(x, h / 2, z);
    bollard.castShadow = true;
    bollard.receiveShadow = true;
    group.add(bollard);
    const rimCap = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 8, 24), laneMat);
    rimCap.rotation.x = Math.PI / 2;
    rimCap.position.set(x, h - 0.06, z);
    group.add(rimCap);
  }

  // Center target: stacked blocks, torus, and a vertical calibration mast.
  const targetGroup = new THREE.Group();
  targetGroup.position.set(-1.4, 0, -8.2);
  group.add(targetGroup);

  const targetMats = [
    material(PALETTE.target, { roughness: 0.45, metalness: 0.1 }),
    material(PALETTE.accent, { emissive: PALETTE.accent, emissiveIntensity: 0.25 }),
    material(0x2a3a48, { roughness: 0.5, metalness: 0.5 }),
  ];
  const blocks = [
    { size: [1.6, 1.6, 1.6], y: 0.8 },
    { size: [1.1, 1.1, 1.1], y: 2.15 },
    { size: [0.62, 0.62, 0.62], y: 3.0 },
  ];
  blocks.forEach((b, i) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...b.size), targetMats[i % targetMats.length]);
    mesh.position.y = b.y;
    mesh.rotation.y = i * 0.35;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    targetGroup.add(mesh);
  });

  const torus = new THREE.Mesh(
    new THREE.TorusGeometry(2.45, 0.075, 12, 96),
    new THREE.MeshStandardMaterial({ color: PALETTE.accent, emissive: PALETTE.accent, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.4 }),
  );
  torus.position.y = 2.1;
  torus.rotation.x = Math.PI / 2.35;
  targetGroup.add(torus);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 6.2, 10), material(0xd8e6f0, { metalness: 0.8, roughness: 0.3 }));
  mast.position.y = 3.1;
  targetGroup.add(mast);

  const mastTip = new THREE.PointLight(PALETTE.accent, 5.5, 8, 2);
  mastTip.position.set(0, 6.25, 0);
  targetGroup.add(mastTip);

  // Distant markers give rotation a visible horizon reference.
  const skylineMat = material(0x162331, { roughness: 0.95, emissive: 0x0a1a26, emissiveIntensity: 0.35 });
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 + 0.4;
    const radius = 34 + (i % 3) * 5;
    const h = 4 + (i % 5) * 3.5;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(3.2, h, 1.1), skylineMat);
    slab.position.set(Math.cos(angle) * radius, h / 2, Math.sin(angle) * radius - 6);
    slab.rotation.y = -angle;
    group.add(slab);
  }

  const ambientDust = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 420 }, (_, i) => {
        const r = 9 + ((i * 37) % 220) / 10;
        const a = (i * 2.39996) % (Math.PI * 2);
        return new THREE.Vector3(Math.cos(a) * r, 0.6 + ((i * 53) % 900) / 100, Math.sin(a) * r - 4);
      }),
    ),
    new THREE.PointsMaterial({ color: 0x5f88a0, size: 0.045, sizeAttenuation: true, transparent: true, opacity: 0.55 }),
  );
  group.add(ambientDust);

  return { scene, group, targetGroup };
}
