import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ClickerPart, MeshData, RGB, ViewMode } from '../types';

export type SectionAxis = 'x' | 'y' | 'z';

export interface Viewer {
  setParts(parts: ClickerPart[]): void;
  setView(mode: ViewMode): void;
  setSection(axis: SectionAxis, pos: number): void;
  setSwitch(mesh: MeshData | null): void;
  showSwitch(on: boolean): void;
  renderToPng(): Promise<Blob | null>;
  setTheme(theme: string): void;
  /** Register a callback fired when the user clicks a colored part of the model. */
  onPartPick(cb: (index: number, clientX: number, clientY: number) => void): void;
  /** Live-recolor a single part's material (no rebuild — geometry is unchanged). */
  setPartColor(index: number, rgb: RGB): void;
  /** Mark a part as the active selection (highlight), or null to clear. */
  highlightPart(index: number | null): void;
  /** Clear hover + selection highlights. */
  clearHighlight(): void;
  dispose(): void;
}

// The grid sits a hair BELOW the model's bottom face (which lands at z = 0) so the
// solid bottom occludes it cleanly — coplanar at z = 0 causes z-fighting that bleeds
// grid lines up through the lower body.
const GRID_GAP = 0.3;

function partToGeometry(p: ClickerPart): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  let positions: Float32Array;
  if (p.numProp === 3) {
    positions = p.vertProperties;
  } else {
    const count = p.vertProperties.length / p.numProp;
    positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = p.vertProperties[i * p.numProp];
      positions[i * 3 + 1] = p.vertProperties[i * p.numProp + 1];
      positions[i * 3 + 2] = p.vertProperties[i * p.numProp + 2];
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(p.triVerts, 1));
  // Crease-split normals: keep the domed top / round walls smooth while keeping
  // hard edges crisp (preview shading only — matches the keycap generator).
  const creased = toCreasedNormals(geo, (35 * Math.PI) / 180);
  geo.dispose();
  return creased;
}

function color(rgb: RGB): THREE.Color {
  return new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
}

export function createViewer(container: HTMLElement): Viewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  // Section view: a single clipping plane swept along an axis.
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const materials: THREE.Material[] = [];
  // Parallel to `materials`/parts: the pickable meshes, each tagged with its part
  // index in userData so a raycast hit maps straight back to the part/material.
  const partMeshes: THREE.Mesh[] = [];
  const bounds = new THREE.Vector3(40, 40, 40);
  let sectionAxis: SectionAxis = 'y';
  let sectionPos = 0;

  const scene = new THREE.Scene();
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  scene.background = new THREE.Color(currentTheme === 'dark' ? 0x15171c : 0xf3f4f6);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    5000,
  );
  camera.up.set(0, 0, 1); // Z up (CAD)
  camera.position.set(60, -60, 45);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(40, -30, 70);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2));

  let gridZ = -20;
  let grid: THREE.GridHelper | null = null;

  function rebuildGrid(theme: string, z: number) {
    if (grid) scene.remove(grid);
    gridZ = z;
    const accentColor = theme === 'dark' ? 0x5b9dff : 0x2563eb;
    const gridColor = theme === 'dark' ? 0x2d3139 : 0xd1d5db;
    grid = new THREE.GridHelper(300, 30, accentColor, gridColor);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = gridZ;
    scene.add(grid);
  }

  rebuildGrid(currentTheme, gridZ);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Root group is recentered for viewing; children keep relative positions.
  const root = new THREE.Group();
  scene.add(root);
  const capGroup = new THREE.Group();
  const bodyGroup = new THREE.Group();
  const switchGroup = new THREE.Group(); // the real MX switch — display-only, toggleable
  switchGroup.visible = false;
  root.add(capGroup, bodyGroup, switchGroup);

  // Instant placeholder clicker so the viewport is never empty while the WASM
  // kernel + switch assets load. It's a plain round cap built from three.js
  // primitives (no worker, no build) and is removed the moment real parts land.
  let placeholder: THREE.Group | null = buildPlaceholder();
  root.add(placeholder);
  framePlaceholder();

  let viewMode: ViewMode = 'assembled';
  let explodeOffset = 0;
  let switchMaterial: THREE.MeshStandardMaterial | null = null;

  // ---- Part picking / hover / selection ----
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const HILITE = new THREE.Color(0x3b82f6);
  let hoveredIndex: number | null = null;
  let selectedIndex: number | null = null;
  let pickCb: ((index: number, clientX: number, clientY: number) => void) | null = null;
  let downX = 0;
  let downY = 0;
  let downT = 0;

  // A plain, pre-built round clicker used as the at-rest placeholder. Pure
  // three.js geometry so it renders instantly on first paint.
  function buildPlaceholder(): THREE.Group {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: color([120, 124, 130]),
      metalness: 0.0,
      roughness: 0.55,
    });
    const capMat = new THREE.MeshStandardMaterial({
      color: color([90, 158, 255]),
      metalness: 0.0,
      roughness: 0.45,
    });

    // Body slab (z 0 → 8).
    const body = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 8, 64), bodyMat);
    body.rotation.x = Math.PI / 2;
    body.position.z = 4;
    g.add(body);

    // Cap (z 8 → 13).
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(18.5, 19.5, 5, 64), capMat);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 10.5;
    g.add(cap);

    // Subtle dome so it reads as a flat-topped keycap rather than a coin.
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(18.5, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      capMat,
    );
    dome.scale.set(1, 1, 0.08);
    dome.rotation.x = Math.PI / 2;
    dome.position.z = 13;
    g.add(dome);

    return g;
  }

  function framePlaceholder() {
    root.position.set(0, 0, 0);
    const radius = 40 * 1.4 + 10;
    camera.position.set(radius, -radius, radius * 0.75);
    controls.target.set(0, 0, 7);
    controls.update();
  }

  function clearPlaceholder() {
    if (!placeholder) return;
    root.remove(placeholder);
    for (const child of placeholder.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    placeholder = null;
  }

  function clearGroup(g: THREE.Group) {
    for (const child of [...g.children]) {
      g.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  function setParts(parts: ClickerPart[]) {
    clearPlaceholder();
    clearGroup(capGroup);
    clearGroup(bodyGroup);
    materials.length = 0;
    partMeshes.length = 0;
    hoveredIndex = null;
    selectedIndex = null;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const mat = new THREE.MeshStandardMaterial({
        color: color(p.colorRgb),
        metalness: 0.0,
        roughness: 0.5,
        side: THREE.DoubleSide, // so the interior shows in section view
      });
      materials.push(mat);
      const mesh = new THREE.Mesh(partToGeometry(p), mat);
      mesh.userData.partIndex = i; // raycast hit -> part/material index
      partMeshes.push(mesh);
      (p.kind === 'body' ? bodyGroup : capGroup).add(mesh);
    }

    // Center X/Y, but place the bottom of the assembly at z = 0 so it sits on the grid.
    root.position.set(0, 0, 0);
    capGroup.position.set(0, 0, 0);
    const box = new THREE.Box3().expandByObject(capGroup).expandByObject(bodyGroup);
    const center = box.getCenter(new THREE.Vector3());
    // Shift X and Y to center, but shift Z so the bottom of the model lands at 0.
    root.position.set(-center.x, -center.y, -box.min.z);

    const size = box.getSize(new THREE.Vector3());
    bounds.copy(size);
    explodeOffset = size.z * 0.8 + 10;
    applyView();

    // Drop the grid just under the model's bottom (which lands at z = 0) so the
    // solid base occludes it instead of z-fighting with the coplanar bottom face.
    const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    rebuildGrid(activeTheme, -GRID_GAP);

    const radius = Math.max(size.x, size.y, size.z) * 1.4 + 10;
    camera.position.set(radius, -radius, radius * 0.75);
    controls.target.set(0, 0, size.z / 2);
    controls.update();

  }

  function updateClipPlane() {
    const n =
      sectionAxis === 'x'
        ? new THREE.Vector3(-1, 0, 0)
        : sectionAxis === 'z'
          ? new THREE.Vector3(0, 0, -1)
          : new THREE.Vector3(0, -1, 0);
    const half = (sectionAxis === 'x' ? bounds.x : sectionAxis === 'z' ? bounds.z : bounds.y) / 2;
    clipPlane.normal.copy(n);
    clipPlane.constant = sectionPos * half;
  }

  function applyView() {
    capGroup.position.z = viewMode === 'exploded' ? explodeOffset : 0;
    const section = viewMode === 'section';
    if (section) updateClipPlane();
    for (const m of materials) (m as THREE.MeshStandardMaterial).clippingPlanes = section ? [clipPlane] : [];
    if (switchMaterial) switchMaterial.clippingPlanes = section ? [clipPlane] : [];
  }

  function setView(mode: ViewMode) {
    viewMode = mode;
    applyView();
  }

  // The real MX switch, already placed in the assembly frame (display only). Smooth
  // shading and no crease-splitting — the mesh is dense (~hundreds of k tris).
  function setSwitch(mesh: MeshData | null) {
    clearGroup(switchGroup);
    switchMaterial = null;
    if (!mesh) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties, 3)); // numProp = 3
    geo.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
    geo.computeVertexNormals();
    switchMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x2a2a30),
      metalness: 0.1,
      roughness: 0.6,
      side: THREE.DoubleSide,
    });
    switchGroup.add(new THREE.Mesh(geo, switchMaterial));
    applyView(); // pick up section clipping if it's active
  }

  function showSwitch(on: boolean) {
    switchGroup.visible = on;
  }

  function setSection(axis: SectionAxis, pos: number) {
    sectionAxis = axis;
    sectionPos = pos;
    if (viewMode === 'section') updateClipPlane();
  }

  async function renderToPng(): Promise<Blob | null> {
    // Render one frame at 2× into an offscreen-sized target, then capture.
    const w = container.clientWidth;
    const h = container.clientHeight;
    const prevRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(Math.min(prevRatio * 2, 4));
    renderer.render(scene, camera);
    const blob = await new Promise<Blob | null>((res) =>
      renderer.domElement.toBlob((b) => res(b), 'image/png'),
    );
    renderer.setPixelRatio(prevRatio);
    renderer.setSize(w, h);
    return blob;
  }

  function onResize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  let raf = 0;
  (function animate() {
    raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  // Paint hover/selection glow via emissive (keeps each part's true base color).
  function applyHighlight() {
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i] as THREE.MeshStandardMaterial;
      if (!m || !m.emissive) continue;
      if (i === selectedIndex) {
        m.emissive.copy(HILITE);
        m.emissiveIntensity = 0.35;
      } else if (i === hoveredIndex) {
        m.emissive.copy(HILITE);
        m.emissiveIntensity = 0.18;
      } else {
        m.emissive.setRGB(0, 0, 0);
        m.emissiveIntensity = 1;
      }
    }
  }

  function pickIndexAt(clientX: number, clientY: number): number | null {
    if (partMeshes.length === 0) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(partMeshes, false);
    for (const h of hits) {
      const idx = (h.object.userData as { partIndex?: number }).partIndex;
      if (typeof idx === 'number') return idx;
    }
    return null;
  }

  const onPointerMove = (e: PointerEvent) => {
    if (e.buttons !== 0) return; // mid orbit/pan — don't fight the controls
    const idx = pickIndexAt(e.clientX, e.clientY);
    renderer.domElement.style.cursor = idx === null ? '' : 'pointer';
    if (idx !== hoveredIndex) {
      hoveredIndex = idx;
      applyHighlight();
    }
  };
  const onPointerLeave = () => {
    if (hoveredIndex !== null) {
      hoveredIndex = null;
      applyHighlight();
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    downX = e.clientX;
    downY = e.clientY;
    downT = performance.now();
  };
  const onPointerUp = (e: PointerEvent) => {
    // Only a tap (not an orbit drag) counts as a part click.
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    if (performance.now() - downT > 500) return;
    const idx = pickIndexAt(e.clientX, e.clientY);
    if (idx === null) return;
    selectedIndex = idx;
    applyHighlight();
    pickCb?.(idx, e.clientX, e.clientY);
  };
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  function onPartPick(cb: (index: number, clientX: number, clientY: number) => void) {
    pickCb = cb;
  }
  function setPartColor(index: number, rgb: RGB) {
    const m = materials[index] as THREE.MeshStandardMaterial | undefined;
    if (m) m.color = color(rgb);
  }
  function highlightPart(index: number | null) {
    selectedIndex = index;
    applyHighlight();
  }
  function clearHighlight() {
    selectedIndex = null;
    hoveredIndex = null;
    applyHighlight();
  }

  function dispose() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    clearGroup(capGroup);
    clearGroup(bodyGroup);
    clearGroup(switchGroup);
    controls.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }
  function setTheme(theme: string) {
    const bgColor = theme === 'dark' ? 0x15171c : 0xf3f4f6;
    scene.background = new THREE.Color(bgColor);
    rebuildGrid(theme, gridZ);
  }

  return {
    setParts,
    setView,
    setSection,
    setSwitch,
    showSwitch,
    renderToPng,
    setTheme,
    onPartPick,
    setPartColor,
    highlightPart,
    clearHighlight,
    dispose,
  };
}
