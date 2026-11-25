// 相亲物语 —— 风景。每种风景是一条很平的大道：玩家在路中间，路两边站着人，再外面是树。全部由代码生成，没有图片素材。
// 坐标：x 向东，z 向南，y 向上；1 个单位大约 1 米。镜头固定朝北看（屏幕上方 = 北），路从南往北延伸。
import { rng, hex } from './pix.js';

export const ROAD_HW = 2.6;   // 路的半宽

/**
 * 风景表（哪个城市用哪种风景在 data.js 里配）。
 * flake 是晴天时飘落物的颜色（花瓣、落叶），fall 是多少；weather 是这种风景各种天气出现的比重（晴、雨、雪）。
 */
export const SCENES = [
  { id: 'sakura', weather: [70, 30, 0], flake: [1.0, 0.78, 0.85], fall: 0.6, dot: '#f7a8c0',
    g1: '#7fae5a', g2: '#96be62', patch: '#f2b8c8', far: '#8fb46a', roadA: '#ece2d2', roadB: '#ddd0bc', trees: ['sak0', 'sak1', 'sak2', 'sak3'], big: 'wish', ground: ['petal', 'petal', 'fl_pink', 'fl_white', 'tuft0'] },
  { id: 'ginkgo', weather: [75, 25, 0], flake: [0.98, 0.8, 0.28], fall: 0.45, dot: '#e9bd3a',
    g1: '#7c8440', g2: '#98903f', patch: '#d2a934', far: '#a8853a', roadA: '#dcc8a8', roadB: '#c9b28e', trees: ['tree_yellow_0', 'tree_yellow_1', 'tree_yellow_2', 'tree_orange_1'], big: 'gk_big', ground: ['leaf', 'leaf', 'tuft2', 'fl_yellow', 'tuft0'] },
  { id: 'pine', weather: [35, 0, 65], flake: [1, 1, 1], fall: 0, dot: '#9fc4d8',
    g1: '#5f7a4a', g2: '#6f8a52', patch: '#7d9a66', far: '#56704a', roadA: '#cfcfd6', roadB: '#bcbcc6', trees: ['pine0', 'pine1', 'pine2', 'pine1'], big: 'pine_big', ground: ['tuft0', 'tuft1', 'tuft0'] },
  { id: 'lantern', weather: [70, 30, 0], flake: [1, 1, 1], fall: 0, dot: '#e2483a', street: true,
    g1: '#6c7c3e', g2: '#7f8744', patch: '#8a8f45', far: '#5f6f3a', roadA: '#d9c7a8', roadB: '#c6b290', trees: ['tree_red_0', 'tree_orange_0', 'tree_olive_1', 'tree_red_2'], big: 'wish', ground: ['tuft0', 'tuft1', 'fl_red'] },
];

// ---------- 噪声 ----------
function hash2(x, y) { let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}
function fbm(x, y, oct = 3) { let a = 0.5, f = 1, s = 0; for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f) * a; a *= 0.5; f *= 2.03; } return s; }
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const C = (s) => hex(s).map((v) => v / 255);
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * 人站的位置：路两边各 ROWS 排，前后错开半个身位。
 * 每边 2 排（2026-11-25 用户在 iPhone 上试了每边 6 排：里面几排点不到、也卡，定成 2 排）。
 * ROW_X0 第一排离路中线多远、ROW_DX 排与排的间距、STEP_Z 同一排前后两个人的间距（米）。
 */
export const ROWS = 2, ROW_X0 = 4.0, ROW_DX = 2.4, STEP_Z = 2.6;
export function slots(n, seed) {
  const r = rng(seed), out = [];
  for (let i = 0; out.length < n; i++) for (let j = 0; j < ROWS && out.length < n; j++) for (const side of [-1, 1]) {
    if (out.length >= n) break;
    out.push({ x: side * (ROW_X0 + j * ROW_DX) + (r() - 0.5) * 0.4, z: -(i * STEP_Z + (j % 2) * STEP_Z * 0.5) + (r() - 0.5) * 0.5, row: j, side });
  }
  return out;
}

/** 地面高度：以路的中点为圆心、flatR 以内是平的（高度 1），再往外起一圈山，给天边一条轮廓 */
export function heightAt(x, z, cz, flatR) {
  const d = Math.hypot(x, z - cz);
  if (d < flatR) return 1;
  return 1 + fbm(x * 0.02, z * 0.02) * 4 * smooth(flatR, flatR + 50, d) + Math.pow(smooth(flatR + 25, flatR + 105, d), 1.35) * 44 * (0.6 + 0.4 * fbm(x * 0.012 + 9, z * 0.012 + 4));
}

class Geo {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.h = []; this.mat = []; }
  tri(a, b, c, n, col, mat = 1) { for (const v of [a, b, c]) { this.pos.push(v[0], v[1], v[2]); this.nor.push(n[0], n[1], n[2]); this.col.push(col[0], col[1], col[2]); this.h.push(50); this.mat.push(mat); } }
  quad(a, b, c, d, col, mat = 1) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(n[0], n[1], n[2]) || 1; n = [n[0] / l, n[1] / l, n[2] / l];
    this.tri(a, b, c, n, col, mat); this.tri(a, c, d, n, col, mat);
  }
  box(x, y0, z, sx, sy, sz, top, side, mat = 1) {
    const x0 = x - sx / 2, x1 = x + sx / 2, z0 = z - sz / 2, z1 = z + sz / 2, y1 = y0 + sy, sd = side.map((v) => v * 0.8);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top, mat);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side, mat);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], sd, mat);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side, mat);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], sd, mat);
  }
}
/** 房子：四面墙 + 人字屋顶，门窗朝南（正对镜头） */
function house(g, o) {
  const { x, z, w, d } = o, y0 = 0.7, hw = 3.1, hr = 2.3, ov = 0.5;
  const wall = C(o.wall || '#ecdcc0'), roof = C(o.roof || '#b5483e'), roofD = roof.map((v) => v * 0.78), wallD = wall.map((v) => v * 0.82);
  const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, yw = y0 + hw + 0.3, yr = yw + hr;
  g.quad([x0, y0, z1], [x1, y0, z1], [x1, yw, z1], [x0, yw, z1], wall);
  g.quad([x1, y0, z1], [x1, y0, z0], [x1, yw, z0], [x1, yw, z1], wallD);
  g.quad([x0, y0, z0], [x0, y0, z1], [x0, yw, z1], [x0, yw, z0], wall);
  g.tri([x1, yw, z1], [x1, yw, z0], [x1, yr, z], [1, 0, 0], wallD);
  g.tri([x0, yw, z0], [x0, yw, z1], [x0, yr, z], [-1, 0, 0], wall);
  g.quad([x0 - ov, yw - 0.25, z1 + ov], [x1 + ov, yw - 0.25, z1 + ov], [x1 + ov, yr, z], [x0 - ov, yr, z], roof);
  g.quad([x1 + ov, yw - 0.25, z0 - ov], [x0 - ov, yw - 0.25, z0 - ov], [x0 - ov, yr, z], [x1 + ov, yr, z], roofD);
  g.quad([x0 - ov, yw - 0.6, z1 + ov + 0.01], [x1 + ov, yw - 0.6, z1 + ov + 0.01], [x1 + ov, yw - 0.25, z1 + ov + 0.01], [x0 - ov, yw - 0.25, z1 + ov + 0.01], roofD);
  const dx = x + (o.door || 0), zf = z1 + 0.03, yg = y0 + 0.3;
  g.quad([dx - 0.65, yg, zf], [dx + 0.65, yg, zf], [dx + 0.65, yg + 2.1, zf], [dx - 0.65, yg + 2.1, zf], C('#6b4630'));
  for (const wx of o.windows || [-w * 0.3, w * 0.3]) {
    const cx = x + wx;
    g.quad([cx - 0.75, yg + 1.0, zf], [cx + 0.75, yg + 1.0, zf], [cx + 0.75, yg + 2.3, zf], [cx - 0.75, yg + 2.3, zf], C('#f6ead0'));
    g.quad([cx - 0.55, yg + 1.15, zf + 0.01], [cx + 0.55, yg + 1.15, zf + 0.01], [cx + 0.55, yg + 2.15, zf + 0.01], [cx - 0.55, yg + 2.15, zf + 0.01], C('#4a5878'), 2);
  }
}

/**
 * 生成一条道：地面网格 + 建筑网格 + 贴片清单 + 灯 + 人站的位置 + 路的范围。
 * count：这条道上要站多少人，路的长度跟着它走（每 STEP_Z 米站 ROWS×2 个人）。
 * 贴片清单里，groundFrom 之后的都是地上的小花小草（手机带不动时可以不画）。
 */
export function buildScene(S, count) {
  const steps = Math.max(6, Math.ceil(count / (ROWS * 2)));
  const len = steps * STEP_Z;                       // 站人的这一段路有多长
  const zS = 16, zN = -(len + 16);                  // 路的南端、北端
  const cz = -len / 2, flatR = len / 2 + 70;        // 平地的圆心和半径
  const people = slots(count, 1000 + count);
  const xOut = ROW_X0 + (ROWS - 1) * ROW_DX;        // 最外一排人的位置
  const SIZE = 2 * (flatR + 112), SEGS = Math.min(230, Math.round(SIZE / 3)), CELL = SIZE / SEGS;   // 地是平的，格子不用密
  const N = SEGS + 1, half = SIZE / 2;
  const pos = new Float32Array(N * N * 3), nor = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), aH = new Float32Array(N * N), aMat = new Float32Array(N * N), hs = new Float32Array(N * N);
  const g1 = C(S.g1), g2 = C(S.g2), patch = C(S.patch), far = C(S.far), rock = C('#6f6480'), snow = C('#efe8f2'), worn = lerp3(C(S.g2), C(S.roadB), 0.35);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) hs[j * N + i] = heightAt(-half + i * CELL, cz - half + j * CELL, cz, flatR);
  const H = (i, j) => hs[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = -half + i * CELL, z = cz - half + j * CELL, h = hs[k];
    pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
    let nx = H(i - 1, j) - H(i + 1, j), nz = H(i, j - 1) - H(i, j + 1), ny = 2 * CELL;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nz;
    const n1 = fbm(x * 0.05 + 11, z * 0.05 + 5), n2 = fbm(x * 0.12 - 7, z * 0.12 + 3, 2);
    let c = lerp3(g1, g2, n2 * 0.5 + 0.5);
    // 人站的两条带子：草被踩得浅一点；树下：落花 / 落叶的颜色
    const ax = Math.abs(x), inBand = smooth(xOut + 3.5, xOut + 0.5, ax) * smooth(zN + 6, zN + 12, z) * smooth(zS - 2, zS - 8, z);
    c = lerp3(c, worn, inBand * 0.45);
    c = lerp3(c, patch, smooth(-0.05, 0.3, n1) * (0.3 + 0.55 * smooth(xOut, xOut + 5, ax)));
    c = lerp3(c, far, smooth(flatR - 40, flatR + 20, Math.hypot(x, z - cz)) * 0.7);
    c = lerp3(c, rock, smooth(0.2, 0.42, 1 - ny));
    c = lerp3(c, snow, smooth(24, 32, h + n2 * 5));
    col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
    aH[k] = 50;
  }
  const idx = new Uint32Array(SEGS * SEGS * 6);
  let q = 0;
  for (let j = 0; j < SEGS; j++) for (let i = 0; i < SEGS; i++) { const a = j * N + i, b = a + 1, c = a + N, d = c + 1; idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d; }

  const g = new Geo(), lights = [], sprites = [];
  const put = (s, x, z, k = 1, flag = 0, dy = 0) => sprites.push({ s, x, z, k, flag, dy });
  const r = rng(7 + count);
  const endZ = zN - 7;                               // 路尽头的大树
  put(S.big, 0, endZ, 1.25, 4);
  for (let a = 0; a < 16; a++) { const t = (a / 16) * Math.PI * 2; g.box(Math.cos(t) * 2.8, 0.9, endZ + Math.sin(t) * 2.8, 1.1, 0.55, 1.1, C('#d9cdbd'), C('#a89c94')); }
  // 路两边的灯
  const lampGap = S.street ? 5.2 : 10.4;
  for (let z = zS - 4; z > zN; z -= lampGap) for (const s of [-1, 1]) { put('lantern', s * (ROAD_HW + 0.55), z, 1, 1); lights.push([s * (ROAD_HW + 0.55), 3.2, z, S.street ? 10 : 12]); }
  // 紧贴在两排人后面的一排行道树（灯笼街是摊位和灯），左右错开；再往外一排，更外面随便长
  const T = S.trees, x1 = xOut + 2.7, x2 = xOut + 7.2;
  for (let z = zS + 24, i = 0; z > zN - 30; z -= 7.8, i++) for (const s of [-1, 1]) {
    const tz = z - (s > 0 ? 3.9 : 0), inRoad = tz < zS - 2 && tz > zN + 2;
    if (S.street && inRoad) {
      put('stall' + ((i + (s > 0 ? 1 : 0)) % 3), s * (x1 + 0.4), tz, 1.05, 0);
      put('lantern', s * (x1 + 2.9), tz + 0.4, 1, 1); lights.push([s * (x1 + 2.9), 3.2, tz + 0.4, 11]);
    } else put(T[(i * 2 + (s > 0 ? 1 : 0)) % T.length], s * (x1 + (r() - 0.5) * 0.6), tz, 1.15 + r() * 0.2, 0);
  }
  if (S.street) {
    const roofs = ['#b5483e', '#3f7f86', '#c98a3a', '#6b5a9a'];
    for (let z = zS - 2, i = 0; z > zN + 2; z -= 10.5, i++) for (const s of [-1, 1]) house(g, { x: s * (x2 + 2), z: z - (s > 0 ? 5 : 0), w: 7.5, d: 5.5, roof: roofs[(i + (s > 0 ? 2 : 0)) % 4], wall: i % 2 ? '#ecdcc0' : '#e3c9a6', door: s * -1.5, windows: [s * 1.6] });
  } else {
    for (let z = zS + 28, i = 0; z > zN - 40; z -= 8.6, i++) for (const s of [-1, 1]) put(T[(i + (s > 0 ? 2 : 0)) % T.length], s * (x2 + (r() - 0.5) * 1.6), z - (s > 0 ? 0 : 4.3) + (r() - 0.5) * 1.5, 1.2 + r() * 0.35);
  }
  const span = 2 * (flatR + 40), want = Math.min(2400, Math.round((span * span) / 70));
  let n = 0, tries = 0;
  while (n < want && tries++ < 60000) {
    const x = (r() - 0.5) * span, z = cz + (r() - 0.5) * span, ax = Math.abs(x);
    if (ax < x2 + (S.street ? 9 : 4) && z < zS + 30 && z > zN - 4) continue;
    if (ax < 9 && z <= zN - 4 && z > zN - 22) continue;         // 路尽头大树周围留空
    if (heightAt(x, z, cz, flatR) > 22) continue;
    const dens = 0.35 + 0.65 * smooth(-0.2, 0.25, fbm(x * 0.03 + 20, z * 0.03 - 9));
    if (r() > dens) continue;
    put(T[(r() * T.length) | 0], x, z, 0.95 + r() * 0.6); n++;
  }
  // 地上的落花、落叶、小草（人脚边也撒，很小，不挡人）。放在清单最后，手机带不动时整段不画
  const groundFrom = sprites.length, wantG = Math.min(5200, Math.round(0.085 * 110 * (len + 110)));
  n = 0; tries = 0;
  while (n < wantG && tries++ < 40000) {
    const x = (r() - 0.5) * 110, z = cz + (r() - 0.5) * (len + 110);
    if (Math.abs(x) < ROAD_HW + 0.4 && z < zS && z > zN) continue;
    put(S.ground[(r() * S.ground.length) | 0], x, z, 1, 0.3); n++;
  }
  // 行道树的影子：把树脚下偏东的地面压暗一点
  for (let si = 0; si < groundFrom; si++) {
    const s = sprites[si];
    if (s.flag !== 0 && s.flag !== 4) continue;
    const big = s.flag === 4 ? 6.5 : 2.6 * s.k, cx = s.x + big * 0.45, cz2 = s.z - big * 0.1;
    const i0 = Math.round((cx + half) / CELL), j0 = Math.round((cz2 - cz + half) / CELL), rad = Math.ceil(big / CELL) + 1;
    for (let j = j0 - rad; j <= j0 + rad; j++) for (let i = i0 - rad; i <= i0 + rad; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const k = j * N + i, dx = (-half + i * CELL - cx) / (big * 1.25), dz = (cz - half + j * CELL - cz2) / (big * 0.8), w = Math.max(0, 1 - (dx * dx + dz * dz)) * 0.36;
      if (w > 0) { col[k * 3] *= 1 - w * 0.9; col[k * 3 + 1] *= 1 - w * 0.85; col[k * 3 + 2] *= 1 - w * 0.6; }
    }
  }
  return {
    terrain: { pos, nor, col, aH, aMat, idx },
    build: { pos: new Float32Array(g.pos), nor: new Float32Array(g.nor), col: new Float32Array(g.col), aH: new Float32Array(g.h), aMat: new Float32Array(g.mat) },
    sprites, groundFrom, lights, people, cz, flatR, len,
    road: { hw: ROAD_HW, zS, zN, endX: 0, endZ, endR: 7.5 },
    bounds: { x: ROAD_HW - 0.35, zS: zS - 3, zN: zN + 1 },
  };
}
