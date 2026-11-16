import * as THREE from 'three';

/**
 * Draws the three named pose components separately:
 *   - base pose wireframe camera (dim, no shake)
 *   - final pose wireframe camera (accent, includes shake)
 *   - connector showing the additive shake offset
 */
export class CameraRigView {
  constructor(scene, rig) {
    this.rig = rig;
    this.group = new THREE.Group();
    this.group.name = 'CameraRigGizmo';
    scene.add(this.group);

    this.baseHelper = this.makeWireCamera(0x3d6a86, 0.4);
    this.finalHelper = this.makeWireCamera(0x28d7e0, 0.95);
    this.group.add(this.baseHelper, this.finalHelper);

    this.connectorGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.connector = new THREE.Line(
      this.connectorGeometry,
      new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 }),
    );
    this.group.add(this.connector);

    this.shakePoint = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb347 }),
    );
    this.group.add(this.shakePoint);

    this.visible = true;
  }

  makeWireCamera(color, opacity) {
    const cam = new THREE.PerspectiveCamera(52, 16 / 9, 0.05, 40);
    cam.position.set(0, 0, 0);
    const helper = new THREE.CameraHelper(cam);
    helper.material.color = new THREE.Color(color);
    helper.material.transparent = true;
    helper.material.opacity = opacity;
    helper.material.depthTest = false;
    helper.renderOrder = 900;
    helper.setColors = () => {};
    return helper;
  }

  setVisible(visible) {
    this.visible = visible;
    this.group.visible = visible;
  }

  update(state) {
    if (!this.visible) return;
    const { base, final } = state;

    this.baseHelper.camera.position.set(base.position.x, base.position.y, base.position.z);
    this.baseHelper.camera.quaternion.set(base.quaternion.x, base.quaternion.y, base.quaternion.z, base.quaternion.w);
    this.baseHelper.camera.fov = 52;
    this.baseHelper.camera.aspect = this.aspect ?? 16 / 9;
    this.baseHelper.camera.updateProjectionMatrix();
    this.baseHelper.update();

    this.finalHelper.camera.position.set(final.position.x, final.position.y, final.position.z);
    this.finalHelper.camera.quaternion.set(final.quaternion.x, final.quaternion.y, final.quaternion.z, final.quaternion.w);
    this.finalHelper.camera.fov = 52;
    this.finalHelper.camera.aspect = this.aspect ?? 16 / 9;
    this.finalHelper.camera.updateProjectionMatrix();
    this.finalHelper.update();

    // Scale the offset marker so sub-centimeter shake remains visible.
    const offset = new THREE.Vector3(
      final.position.x - base.position.x,
      final.position.y - base.position.y,
      final.position.z - base.position.z,
    );
    const magnitude = offset.length();
    const display = magnitude > 1e-9 ? offset.clone().multiplyScalar(Math.max(1, 0.25 / magnitude)) : offset;
    this.connectorGeometry.setFromPoints([
      new THREE.Vector3(base.position.x, base.position.y, base.position.z),
      new THREE.Vector3(base.position.x + display.x, base.position.y + display.y, base.position.z + display.z),
    ]);
    this.connectorGeometry.attributes.position.needsUpdate = true;
    this.shakePoint.position.set(base.position.x + display.x, base.position.y + display.y, base.position.z + display.z);
    this.shakePoint.visible = magnitude > 1e-9;
    this.connector.visible = magnitude > 1e-9;
  }

  setAspect(aspect) {
    this.aspect = aspect;
  }

  dispose() {
    this.group.removeFromParent();
    this.baseHelper.dispose?.();
    this.finalHelper.dispose?.();
    this.connectorGeometry.dispose();
    this.shakePoint.geometry.dispose();
  }
}
