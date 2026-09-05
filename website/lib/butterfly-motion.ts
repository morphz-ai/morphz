type Point = readonly [number, number];
type Curve = readonly [Point, Point, Point, Point];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (t: number) => Math.max(0, Math.min(1, t));
const smooth = (t: number) => { const x = clamp(t); return x * x * (3 - 2 * x); };
const mix = (a: Point, b: Point, t: number): Point => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

function split([a, b, c, d]: Curve): [Curve, Curve] {
  const ab = mix(a, b, 0.5), bc = mix(b, c, 0.5), cd = mix(c, d, 0.5);
  const abc = mix(ab, bc, 0.5), bcd = mix(bc, cd, 0.5), middle = mix(abc, bcd, 0.5);
  return [[a, ab, abc, middle], [middle, bcd, cd, d]];
}

// The approved v1 upper wing, split without changing its shape. Matching cubic
// segments let it become the exact existing M, independently of CSS path support.
const originalCurves: Curve[] = [
  [[26, 26], [22, 73], [28, 115], [56, 138]],
  [[56, 138], [75, 153], [99, 153], [119, 140]],
  [[119, 140], [103, 105], [68, 56], [26, 26]],
];
const butterfly = originalCurves.flatMap(split);

// Original 96-unit mark in the butterfly's 256-unit coordinate system.
const corners: Point[] = [[8, 4], [8, 92], [38, 70], [38, 40], [48, 40], [30, 23.8], [8, 4]];
const mark: Curve[] = corners.slice(0, -1).map((corner, index) => {
  const a: Point = [corner[0] * 8 / 3, corner[1] * 8 / 3];
  const next = corners[index + 1];
  const b: Point = [next[0] * 8 / 3, next[1] * 8 / 3];
  return [a, mix(a, b, 1 / 3), mix(a, b, 2 / 3), b];
});

export function butterflyWingPath(progress: number): string {
  const t = clamp(progress);
  const point = (a: Point, b: Point) => mix(a, b, t).map((n) => n.toFixed(3)).join(" ");
  return `M${point(butterfly[0][0], mark[0][0])}${butterfly.map((curve, i) =>
    `C${curve.slice(1).map((p, j) => point(p, mark[i][j + 1])).join(" ")}`,
  ).join("")}Z`;
}

export const ARRIVAL_DELAY = 350;
export const ARRIVAL_DURATION = 3200;

export type ArrivalGeometry = { x: number; y: number; size: number; hoverX: number; hoverY: number; hoverSize: number; travel: number };

export function arrivalFrame(elapsed: number, geometry: ArrivalGeometry) {
  const { x, y, size, hoverX, hoverY, hoverSize, travel } = geometry;
  const flight = clamp(elapsed / 900);
  const hover = clamp((elapsed - 900) / 650);
  const morph = smooth((elapsed - 1550) / 650);
  const landing = smooth((elapsed - 2200) / 850);
  const flying = elapsed < 900;
  const wingCycles = flying ? elapsed / 300 : 3 + (elapsed - 900) / 390;
  const flutter = elapsed < 1550 ? 1 - 0.57 * (0.5 - Math.cos(wingCycles * Math.PI * 2) / 2) : 1;
  return {
    phase: elapsed < 900 ? "flight" : elapsed < 1550 ? "hover" : elapsed < 2200 ? "morph" : elapsed < 3050 ? "landing" : "settled",
    x: flying ? hoverX + travel * Math.pow(1 - flight, 3) : lerp(hoverX, x, landing),
    y: flying ? hoverY + (1 - flight) * 20 - Math.sin(Math.PI * flight) * 30 :
      lerp(hoverY, y, landing) + (elapsed < 1550 ? Math.sin(hover * Math.PI * 2) * 2 : 0) - Math.sin(landing * Math.PI) * 18,
    size: lerp(hoverSize, size, landing),
    angle: flying ? -12 * Math.pow(1 - flight, 2) : 0,
    opacity: smooth(elapsed / 160),
    flutter: lerp(flutter, 1, smooth((elapsed - 1350) / 200)),
    morph,
    detailOpacity: 1 - smooth((elapsed - 1550) / 380),
    lowerScale: 1 - 0.65 * morph,
    path: butterflyWingPath(morph),
  };
}

export function cyanStop(color: readonly number[], progress: number): string {
  return `rgb(${[86, 208, 222].map((n, i) => Math.round(lerp(color[i], n, clamp(progress)))).join(",")})`;
}
