// Regression test for the "geometric shape ignores Size" bug.
//
// Bug: for geometric base shapes (circle, square, …) the "Size" (capWidthMm) sized
// the embedded IMAGE and then the shape was grown to circumscribe it, so a 50 mm
// circle came out ~65–70 mm. Fix: the finished clicker's OUTER longest side (the
// body/bezel — what a caliper measures on the assembled part) must equal Size.
//
// This drives the REAL buildClicker geometry (manifold WASM) with stand-in socket/
// stem solids and measures the BODY (base-body) XY footprint.
import wasmFactory from 'manifold-3d';
import { buildClicker } from '../src/geometry/buildClicker.ts';
import type { BuildParams, BuildRegion, Ring } from '../src/types.ts';

const m = await wasmFactory();
m.setup();
const { Manifold } = m as any;

// Stand-in switch assets: only their bounding boxes matter to buildClicker's Z stack
// and min-cap floor (socketDim). XY of the cap is independent of these.
const socket = Manifold.cube([14, 14, 5], true).translate([0, 0, -2.5]); // top at z=0
const stem = Manifold.cube([5, 5, 4], true).translate([0, 0, -2.5]); // top at z=-0.5

const baseParams: BuildParams = {
  baseShape: 'circle',
  capWidthMm: 50,
  topThickness: 2,
  imageDepth: 1,
  imageMargin: 1.2,
  borderWidth: 2.6,
  capProud: 4,
  tolerance: 0.15,
  colorBleed: 0.12,
  stepHeight: 0.6,
  travel: 4,
  floorThickness: 1.6,
  keychainHole: false,
  baseFilamentRgb: [200, 200, 200],
  bodyColorRgb: [120, 124, 130],
  componentHeights: {},
  edgeSettings: [],
};

const squareOutline: Ring[] = [[[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]];
const tallOutline: Ring[] = [[[-0.4, -0.5], [0.4, -0.5], [0.4, 0.5], [-0.4, 0.5]]]; // 0.8:1

function longestSide(part: { vertProperties: Float32Array; numProp: number }): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const vp = part.vertProperties, np = part.numProp;
  for (let i = 0; i < vp.length; i += np) {
    const x = vp[i], y = vp[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

// Returns the OUTER (body) longest side — the physical outer size of the clicker.
function bodyLongestSide(shape: string, capWidthMm: number, outline: Ring[]): number {
  const params: BuildParams = { ...baseParams, baseShape: shape as any, capWidthMm };
  const regions: BuildRegion[] = [];
  const parts = buildClicker(m as any, socket, stem, regions, outline, params);
  const body = parts.find((p) => p.name === 'base-body');
  if (!body) throw new Error('no base-body part produced');
  return longestSide(body);
}

const cases: [string, string, number, Ring[]][] = [
  ['circle', 'circle', 50, squareOutline],
  ['circle', 'circle', 60, squareOutline],
  ['circle (tall image)', 'circle', 50, tallOutline],
  ['square', 'square', 50, squareOutline],
  ['hexagon', 'hexagon', 50, squareOutline],
];

const TOL = 0.5; // mm; the body's outer longest side must equal Size within this
let ok = true;
console.log('shape                | Size | body outer  | Δ');
console.log('---------------------|------|-------------|------');
for (const [label, shape, size, outline] of cases) {
  const got = bodyLongestSide(shape, size, outline);
  const delta = got - size;
  const pass = Math.abs(delta) <= TOL;
  if (!pass) ok = false;
  console.log(
    `${label.padEnd(20)} | ${String(size).padStart(4)} | ${got.toFixed(2).padStart(11)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}  ${pass ? 'PASS' : 'FAIL'}`,
  );
}
console.log(ok ? '\nALL SIZE CHECKS PASSED' : '\nSIZE CHECKS FAILED');
process.exit(ok ? 0 : 1);
