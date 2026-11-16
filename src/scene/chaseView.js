import * as THREE from 'three';

/**
 * A second renderer that observes the rig from behind and to the side, so the
 * base frustum, the shaken frustum and the offset between them can be seen
 * even when the main view's motion is subtle. It is a diagnostic view: the
 * main camera above is the one producing the rendered game-like perspective.
 */
export class ChaseView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05090d);
    this.scene.fog = new THREE.Fog(0x05090d, 18, 44);

    this.stage = new THREE.Group();
    this.scene.add(this.stage);

    this.scene.add(new THREE.HemisphereLight(0x9dbdd4, 0x0a0f15, 0.8));
    const key = new THREE.DirectionalLight(0xe7f3ff, 1.7);
    key.position.set(7, 12, 6);
    this.scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x0d151d, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(60, 60, 0x24404f, 0x14222c);
    grid.position.y = 0.01;
    this.scene.add(grid);

    // A stand-in target so the frustums have something to point at.
    const target = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 1.3, 1.3),
      new THREE.MeshStandardMaterial({ color: 0x1d3342, roughness: 0.5, metalness: 0.3 }),
    );
    target.position.set(0, 1.6, 0);
    this.stage.add(target);
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(1.1, 0.04, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0x28d7e0 }),
    );
    marker.position.copy(target.position);
    marker.rotation.x = Math.PI / 2;
    this.stage.add(marker);

    this.baseHelper = new THREE.CameraHelper(new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 20));
    this.baseHelper.material.color = new THREE.Color(0x5d8299);
    this.baseHelper.material.transparent = true;
    this.baseHelper.material.opacity = 0.6;
    this.finalHelper = new THREE.CameraHelper(new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 20));
    this.finalHelper.material.color = new THREE.Color(0x28d7e0);
    this.finalHelper.material.transparent = true;
    this.finalHelper.material.opacity = 0.95;
    this.scene.add(this.baseHelper, this.finalHelper);

    this.offsetGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.offsetLine = new THREE.Line(
      this.offsetGeometry,
      new THREE.LineBasicMaterial({ color: 0xffb347, linewidth: 2 }),
    );
    this.scene.add(this.offsetLine);

    this.orbitCamera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 200);
    this.orbitCamera.rotation.order = 'YXZ';
    this.orbitAngle = 0.55;
    this.orbitTarget = new THREE.Vector3(0, 1.8, 4.4);

    this.aspect = 16 / 9;
  }

  resize(width, height) {
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.aspect = width / height;
    for (const helper of [this.baseHelper, this.finalHelper]) {
      helper.camera.aspect = this.aspect;
      helper.camera.updateProjectionMatrix();
    }
    this.orbitCamera.aspect = this.aspect;
    this.orbitCamera.updateProjectionMatrix();
  }

  update(stateAtTime) {
    const { base, final } = stateAtTime;
    for (const [helper, pose] of [[this.baseHelper, base], [this.finalHelper, final]]) {
      helper.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
      helper.camera.quaternion.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
      helper.camera.updateProjectionMatrix();
      helper.update();
    }

    this.offsetGeometry.setFromPoints([
      new THREE.Vector3(base.position.x, base.position.y, base.position.z),
      new THREE.Vector3(final.position.x, final.position.y, final.position.z),
    ]);
    this.offsetGeometry.attributes.position.needsUpdate = true;

    // Frame both camera frustums from a fixed three-quarter chase angle.
    const midpoint = this.orbitTarget;
    midpoint.set(
      (base.position.x + final.position.x) / 2,
      (base.position.y + final.position.y) / 2,
      (base.position.z + final.position.z) / 2,
    );
    const lookAt = new THREE.Vector3(0, 1.7, 0);
    const dir = new THREE.Vector3().subVectors(midpoint, lookAt);
    const dist = dir.length() || 5;
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    this.orbitCamera.position.copy(midpoint)
      .addScaledVector(dir.clone().normalize(), -0.55 * dist)
      .addScaledVector(side, 0.62 * dist)
      .add(new THREE.Vector3(0, 1.4 + 0.18 * dist, 0));
    this.orbitCamera.lookAt(lookAt);
  }

  render() {
    this.renderer.render(this.scene, this.orbitCamera);
  }
}
