// 相亲物语 —— 像素贴片：树、摊位、灯笼、小人、像素头像……全部用代码一个像素一个像素画出来，
// 不用任何外部图片（不用别的游戏的图，也不用网上的素材包）。

/** 带种子的随机数：同一个种子每次画出来一样 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hexCache = new Map();
export function hex(s) {
  let v = hexCache.get(s);
  if (!v) { v = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]; hexCache.set(s, v); }
  return v;
}
/** 0..1 的颜色（给着色器用） */
export const rgb = (s) => hex(s).map((v) => v / 255);

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

/** 一小块像素画布 */
export class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }
  set(x, y, c, a = 255) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (typeof c === 'string') c = hex(c);
    const i = (y * this.w + x) * 4, d = this.d;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  }
  clear(x, y) { if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.d[(y * this.w + x) * 4 + 3] = 0; }
  has(x, y) { if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false; return this.d[(y * this.w + x) * 4 + 3] > 0; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  /** 外面描一圈深色边，尺寸各大 2 */
  outlined(c) {
    const o = new Pix(this.w + 2, this.h + 2);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = (y * this.w + x) * 4;
      if (this.d[i + 3]) o.set(x + 1, y + 1, [this.d[i], this.d[i + 1], this.d[i + 2]], this.d[i + 3]);
    }
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
      if (this.has(x - 1, y - 1)) continue;
      if (this.has(x - 2, y - 1) || this.has(x, y - 1) || this.has(x - 1, y - 2) || this.has(x - 1, y)) o.set(x, y, c);
    }
    return o;
  }
  mirrored() {
    const o = new Pix(this.w, this.h);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = (y * this.w + x) * 4, j = (y * this.w + (this.w - 1 - x)) * 4;
      o.d[j] = this.d[i]; o.d[j + 1] = this.d[i + 1]; o.d[j + 2] = this.d[i + 2]; o.d[j + 3] = this.d[i + 3];
    }
    return o;
  }
}

// ---------- 调色板：暗 / 中 / 亮 / 高光，out 是描边色 ----------
export const PAL = {
  red: { c: ['#8f2f2b', '#c8452f', '#e2683a', '#f5a05c'], out: '#4a1f2a' },
  orange: { c: ['#a8552a', '#d9822b', '#f0a63c', '#f9d070'], out: '#55301f' },
  yellow: { c: ['#9a7a25', '#c9a227', '#e3c13e', '#f6e27c'], out: '#4f3f1f' },
  olive: { c: ['#44592f', '#5f7a3c', '#829a45', '#b1c063'], out: '#263320' },
  pine: { c: ['#1c3a36', '#255046', '#33695a', '#5c8a6a'], out: '#12242a' },
  pink: { c: ['#b04a78', '#d96b8f', '#f093ad', '#ffc9d6'], out: '#5a2848' },
  sakura: { c: ['#cf7397', '#f09ab6', '#fbbdd0', '#ffe6ee'], out: '#7a3a5a' },
  sakura2: { c: ['#d98fa8', '#f6b2c6', '#fdd0dc', '#fff3f6'], out: '#8a4a66' },
  rock: { c: ['#4f4660', '#6e6480', '#8e84a0', '#b4abc2'], out: '#2e2838' },
};
const TRUNK = '#5a3a2e', TRUNK_L = '#7d5239', DARK = '#2a1f2e';

/** 一团一团的树冠：几个椭圆叠在一起，按左上来光分四档明暗，中间用点阵过渡 */
function canopy(p, cx, cy, rx, ry, pal, r, lumps = 7) {
  const blobs = [{ x: cx, y: cy, rx: rx * 0.8, ry: ry * 0.8 }];
  for (let i = 0; i < lumps; i++) {
    const a = r() * Math.PI * 2, d = 0.3 + r() * 0.5, s = 0.42 + r() * 0.25;
    blobs.push({ x: cx + Math.cos(a) * rx * d, y: cy + Math.sin(a) * ry * d * 0.9, rx: rx * s, ry: ry * s });
  }
  const inside = (x, y) => blobs.some((b) => { const nx = (x + 0.5 - b.x) / b.rx, ny = (y + 0.5 - b.y) / b.ry; return nx * nx + ny * ny <= 1; });
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
    let best = -9, hit = false;
    for (const b of blobs) {
      const nx = (x + 0.5 - b.x) / b.rx, ny = (y + 0.5 - b.y) / b.ry, q = nx * nx + ny * ny;
      if (q > 1) continue;
      hit = true;
      const l = (-nx * 0.55 - ny * 0.8) * (0.65 + 0.35 * Math.sqrt(1 - q));
      if (l > best) best = l;
    }
    if (!hit) continue;
    const g = (cy - (y + 0.5)) / ry * 0.38 + (cx - (x + 0.5)) / rx * 0.16;
    const v = best * 0.62 + g + (bayer(x, y) - 0.5) * 0.24 + (r() - 0.5) * 0.14;
    let c = v > 0.6 ? pal.c[3] : v > 0.2 ? pal.c[2] : v > -0.28 ? pal.c[1] : pal.c[0];
    if (!inside(x, y + 1)) c = pal.c[0]; // 树冠底边压暗
    p.set(x, y, c);
  }
}

/** 圆树（参考里成片的红、橙、黄树） */
export function roundTree(seed, pal, w = 36, h = 44, lumps = 8) {
  const r = rng(seed), p = new Pix(w, h), cx = w / 2;
  const ch = h - Math.max(11, Math.round(h * 0.22)); // 树冠占的高度
  for (let y = (ch * 0.6) | 0; y < h; y++) {
    p.set(cx - 2, y, TRUNK_L); p.set(cx - 1, y, TRUNK); p.set(cx, y, TRUNK); p.set(cx + 1, y, '#452c26');
  }
  p.set(cx - 3, h - 1, TRUNK); p.set(cx + 2, h - 1, '#452c26');
  if (w > 50) for (let y = (ch * 0.6) | 0; y < h; y++) { p.set(cx - 3, y, TRUNK_L); p.set(cx + 2, y, '#452c26'); }
  canopy(p, cx, ch / 2, w / 2 - 1, ch / 2 - 0.5, pal, r, lumps);
  return p.outlined(pal.out);
}

/** 地上的落花 / 落叶：两三个小点 */
export function litter(seed, a, b) {
  const r = rng(seed), p = new Pix(7, 4);
  for (let i = 0; i < 4; i++) p.set((r() * 7) | 0, (r() * 4) | 0, r() > 0.4 ? a : b);
  return p;
}

/**
 * 像素头像（样稿里给没有示意照片的假用户用；真实用户这里显示的是他们自己的照片）。
 * 22×22，每个种子一个样子：底色、发型、发色、衣服颜色都不一样。
 */
export function portrait(seed, female = true) {
  const r = rng(seed), p = new Pix(22, 22);
  const pick = (a) => a[(r() * a.length) | 0];
  const bg = pick(['#ffd9e2', '#ffe6cf', '#d9f0e4', '#d6e8fb', '#e9defa', '#fff1c9', '#f9d6ee', '#d8eef2']);
  const skin = pick(['#f8d8bd', '#f3ccaa', '#f6d3b4', '#efc6a2']), skinD = shade(skin, 0.88);
  const hair = pick(['#2e2530', '#33262a', '#4a3028', '#5a3a2e', '#6b3f2e', '#2a2430', '#3a2c36', '#7a4a32']), hairL = shade(hair, 1.35);
  const top = pick(['#f6ead0', '#f39a5a', '#7fae8a', '#b79ad6', '#4a78b8', '#e2683a', '#ffffff', '#d96b8f', '#3f8f96', '#ffd24a']);
  const style = female ? (r() * 4) | 0 : 4, fringe = (r() * 3) | 0;
  p.rect(0, 0, 22, 22, bg);
  const ell = (cx, cy, rx, ry, c) => { for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) { const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry; if (nx * nx + ny * ny <= 1) p.set(x, y, c); } };
  // 后面的头发
  if (style === 0) { ell(11, 9.5, 7.6, 7.6, hair); p.rect(4, 9, 14, 12, hair); }
  else if (style === 1) { ell(11, 9.5, 7.4, 7.4, hair); p.rect(4, 9, 14, 6, hair); }
  else if (style === 2) { ell(11, 9, 6.6, 6.6, hair); ell(17.5, 6, 2.6, 3.4, hair); p.rect(17, 7, 3, 8, hair); }
  else if (style === 3) { ell(11, 9, 6.8, 6.8, hair); ell(11, 2.8, 2.6, 2.4, hair); }
  else ell(11, 8.6, 6.3, 6, hair);
  // 肩膀、脖子、脸
  for (let y = 17; y < 22; y++) { const e = Math.min(4, y - 17); p.rect(6 - e, y, 10 + e * 2, 1, top); }
  p.rect(9, 15, 4, 3, skinD);
  ell(11, 10.5, 5.2, 6, skin);
  // 刘海
  for (let x = 6; x <= 16; x++) {
    const d = fringe === 0 ? 2 : fringe === 1 ? Math.max(0, 3 - ((x - 6) >> 1)) : Math.abs(x - 11) > 1 ? 2 + (Math.abs(x - 11) > 3 ? 1 : 0) : 0;
    for (let y = 4; y < 5 + d; y++) if (p.has(x, y)) p.set(x, y, x < 9 ? hairL : hair);
  }
  for (let x = 6; x <= 16; x++) p.set(x, 4, hair);
  if (style !== 4) { for (let y = 6; y < 13; y++) { p.set(5, y, hair); p.set(16, y, hair); } }
  p.set(8, 10, DARK); p.set(8, 11, DARK); p.set(13, 10, DARK); p.set(13, 11, DARK);
  if (female) { p.set(7, 13, '#f7a3a8'); p.set(14, 13, '#f7a3a8'); }
  p.set(10, 14, '#d9667a'); p.set(11, 14, '#d9667a');
  return p;
}
/** 像素块转成图片地址（给网页元素当背景图用） */
export function toURL(pix) {
  const c = document.createElement('canvas'); c.width = pix.w; c.height = pix.h;
  c.getContext('2d').putImageData(new ImageData(pix.d, pix.w, pix.h), 0, 0);
  return c.toDataURL();
}

/** 松树：几层三角叠起来 */
export function pine(seed, pal = PAL.pine, w = 22, h = 48) {
  const r = rng(seed), p = new Pix(w, h), cx = (w / 2) | 0;
  for (let y = h - 8; y < h; y++) { p.set(cx - 1, y, TRUNK_L); p.set(cx, y, TRUNK); p.set(cx + 1, y, '#452c26'); }
  const tiers = 5, th = 13;
  for (let i = tiers - 1; i >= 0; i--) {
    const top = 1 + i * 7, maxhw = 3 + i * 1.7;
    for (let y = top; y < top + th && y < h - 5; y++) {
      const k = (y - top) / (th - 1), hw = 0.6 + k * maxhw;
      for (let x = Math.ceil(cx - hw); x <= Math.floor(cx + hw); x++) {
        const rel = (x - cx) / Math.max(hw, 1);
        const v = -rel * 0.7 - k * 0.25 + (bayer(x, y) - 0.5) * 0.4 + (r() - 0.5) * 0.2;
        let c = v > 0.42 ? pal.c[3] : v > 0.05 ? pal.c[2] : v > -0.4 ? pal.c[1] : pal.c[0];
        if (y === top + th - 1 || y === h - 6) c = pal.c[0];
        p.set(x, y, c);
      }
    }
  }
  return p.outlined(pal.out);
}

/** 灌木 / 石头：一团，没有树干 */
export function clump(seed, pal, w = 16, h = 11) {
  const r = rng(seed), p = new Pix(w, h);
  canopy(p, w / 2, h / 2 + 1, w / 2 - 0.5, h / 2 - 0.5, pal, r, 4);
  for (let x = 0; x < w; x++) for (let y = h - 1; y >= h - 2; y--) if (p.has(x, y) && !p.has(x, y - 2)) p.clear(x, y);
  return p.outlined(pal.out);
}

/** 许愿树：大号的粉色树，枝上挂红绸带 */
export function wishTree(seed) {
  const w = 92, h = 92, r = rng(seed), p = new Pix(w, h), cx = w / 2;
  for (let y = 46; y < h; y++) {
    const wd = y > h - 4 ? 6 : y > h - 12 ? 4 : 3;
    for (let x = -wd; x <= wd; x++) p.set(cx + x, y, x < -1 ? TRUNK_L : x > 1 ? '#452c26' : TRUNK);
  }
  for (let i = 0; i < 12; i++) { p.set(cx - 5 - i, 60 - i, TRUNK); p.set(cx - 4 - i, 60 - i, TRUNK_L); p.set(cx + 4 + i, 58 - i, '#452c26'); p.set(cx + 5 + i, 58 - i, TRUNK); p.set(cx - 5 - i, 61 - i, '#452c26'); }
  // 树冠：很多小团叠起来，才有一簇一簇花的样子
  const blobs = [];
  for (let i = 0; i < 46; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r());
    blobs.push({ x: cx + Math.cos(a) * d * 30, y: 31 + Math.sin(a) * d * 19 - 2, r: 7 + r() * 6 });
  }
  const lit = [-0.6, -0.8];
  for (let y = 0; y < 62; y++) for (let x = 0; x < w; x++) {
    let best = -9, hit = false;
    for (const b of blobs) {
      const nx = (x + 0.5 - b.x) / b.r, ny = (y + 0.5 - b.y) / b.r, q = nx * nx + ny * ny;
      if (q > 1) continue; hit = true;
      const l = (nx * lit[0] + ny * lit[1]) * (0.55 + 0.45 * Math.sqrt(1 - q)) + (31 - b.y) * 0.018 + (cx - b.x) * 0.008;
      if (l > best) best = l;
    }
    if (!hit) continue;
    const v = best + (bayer(x, y) - 0.5) * 0.3 + (r() - 0.5) * 0.16;
    p.set(x, y, v > 0.62 ? PAL.pink.c[3] : v > 0.18 ? PAL.pink.c[2] : v > -0.3 ? PAL.pink.c[1] : PAL.pink.c[0]);
  }
  for (let x = 0; x < w; x++) for (let y = 61; y > 20; y--) if (p.has(x, y) && !p.has(x, y + 1) && y > 36) { p.set(x, y, PAL.pink.c[0]); break; }
  // 红绸带：从树冠下沿垂下来，末端一点金色
  for (let i = 0; i < 22; i++) {
    const x = 12 + ((r() * (w - 24)) | 0);
    let y = 34; while (y < 66 && p.has(x, y)) y++;
    if (y < 40 || y > 62 || Math.abs(x - cx) < 5) continue;
    const len = 4 + ((r() * 5) | 0);
    for (let k = 0; k < len; k++) p.set(x, y + k, k === len - 1 ? '#ffd24a' : '#e02f3f');
  }
  return p.outlined(PAL.pink.out);
}

/** 小花 */
export function flower(col, mid = '#ffe27a') {
  const p = new Pix(5, 6);
  p.set(2, 5, '#4f7a3a'); p.set(2, 4, '#4f7a3a'); p.set(2, 3, '#4f7a3a'); p.set(1, 4, '#5f8f45');
  p.set(2, 0, col); p.set(1, 1, col); p.set(3, 1, col); p.set(2, 2, col); p.set(2, 1, mid);
  return p;
}
/** 草丛 */
export function tuft(seed, a = '#5f7a3c', b = '#8aa04a') {
  const r = rng(seed), p = new Pix(7, 5);
  for (let x = 0; x < 7; x++) { const hgt = 1 + ((r() * 4) | 0); for (let k = 0; k < hgt; k++) p.set(x, 4 - k, k === hgt - 1 ? b : a); }
  return p;
}

/** 集市的摊位：条纹雨棚 + 木台子 + 台上的货 */
export function stall(seed, awn = '#d9534a', goods = ['#e2483a', '#f0a63c', '#7fae4a']) {
  const r = rng(seed), w = 34, h = 28, p = new Pix(w, h);
  for (let y = 9; y < h; y++) { p.set(2, y, '#6b4630'); p.set(3, y, '#8a5f3c'); p.set(w - 4, y, '#6b4630'); p.set(w - 3, y, '#57382a'); }
  for (let y = 1; y < 9; y++) for (let x = 0; x < w; x++) {
    const stripe = ((x / 4) | 0) % 2 === 0;
    let c = stripe ? awn : '#f6ead0';
    if (y >= 7) c = stripe ? shade(awn, 0.78) : '#dccdae';
    if (y === 8 && ((x / 2) | 0) % 2 === 1) continue; // 雨棚下沿的小波浪
    p.set(x, y, c);
  }
  for (let x = 0; x < w; x++) p.set(x, 0, shade(awn, 1.15));
  p.rect(3, 18, w - 6, 2, '#b98552'); p.rect(3, 20, w - 6, 7, '#8a5f3c');
  for (let x = 3; x < w - 3; x += 5) p.rect(x, 20, 1, 7, '#6b4630');
  for (let x = 5; x < w - 6; x += 3) {
    const c = goods[(r() * goods.length) | 0];
    p.set(x, 17, c); p.set(x + 1, 17, c); p.set(x, 16, c); if (r() > 0.5) p.set(x + 1, 16, shade(c, 1.2));
  }
  return p.outlined(DARK);
}

/** 灯笼杆 */
export function lantern() {
  const p = new Pix(7, 22);
  p.rect(3, 7, 1, 15, '#3a2c36'); p.rect(2, 21, 3, 1, '#3a2c36'); p.rect(1, 0, 5, 1, '#3a2c36');
  p.rect(1, 1, 5, 6, '#e23b3b'); p.rect(2, 2, 3, 4, '#ff8a3a'); p.rect(3, 3, 1, 2, '#ffe07a'); p.rect(1, 7, 5, 1, '#c9a227');
  return p;
}
/** 长椅 */
export function bench() {
  const p = new Pix(16, 9);
  p.rect(0, 0, 16, 2, '#a8774a'); p.rect(0, 2, 16, 1, '#6b4630'); p.rect(0, 4, 16, 2, '#b98552'); p.rect(0, 6, 16, 1, '#6b4630');
  p.rect(1, 3, 1, 6, '#57382a'); p.rect(14, 3, 1, 6, '#57382a');
  return p.outlined(DARK);
}
/** 茶桌 + 两个凳子 */
export function teaTable() {
  const p = new Pix(18, 10);
  p.rect(4, 2, 10, 2, '#b98552'); p.rect(4, 4, 10, 1, '#6b4630'); p.rect(8, 5, 2, 5, '#6b4630');
  p.rect(7, 0, 2, 2, '#f6ead0'); p.rect(10, 1, 1, 1, '#f6ead0');
  p.rect(0, 6, 3, 1, '#a8774a'); p.rect(1, 7, 1, 3, '#57382a'); p.rect(15, 6, 3, 1, '#a8774a'); p.rect(16, 7, 1, 3, '#57382a');
  return p.outlined(DARK);
}
/** 小木船 */
export function boat() {
  const p = new Pix(20, 8);
  for (let y = 2; y < 7; y++) { const ind = y - 2; for (let x = ind; x < 20 - ind; x++) p.set(x, y, y === 2 ? '#c9925a' : y < 5 ? '#a8774a' : '#7d5239'); }
  p.rect(6, 3, 8, 1, '#6b4630');
  return p.outlined(DARK);
}
/** 木箱 */
export function crate() {
  const p = new Pix(8, 7);
  p.rect(0, 0, 8, 7, '#a8774a'); p.rect(0, 0, 8, 1, '#c9925a'); p.rect(0, 3, 8, 1, '#7d5239'); p.rect(3, 0, 1, 7, '#7d5239');
  return p.outlined(DARK);
}

export function shade(c, k) { const v = hex(c); return [Math.min(255, v[0] * k), Math.min(255, v[1] * k), Math.min(255, v[2] * k)]; }

/**
 * 小人：16×22（描边后 18×24）。dir：0 正面（朝屏幕外） 1 背面 2 朝右；frame：0 站 1、2 走。
 * look：{ skin, hair, top, bottom, shoe, female }
 */
export function person(look, dir, frame) {
  const p = new Pix(16, 22);
  const { skin, hair, top, bottom, female } = look;
  const shoe = look.shoe || '#3a2c36';
  const skinD = shade(skin, 0.86), hairD = shade(hair, 0.75), topD = shade(top, 0.8), botD = shade(bottom, 0.8);
  const bob = frame === 2 ? 0 : 0;
  const HEAD = [[5, 10], [4, 11], [3, 12], [3, 12], [3, 12], [3, 12], [3, 12], [3, 12], [4, 11], [5, 10]]; // 每行头的左右边界
  const headRow = (y, fn) => { const [a, b] = HEAD[y]; for (let x = a; x <= b; x++) fn(x); };

  if (dir === 2) {
    // ---- 侧面（朝右）----
    for (let y = 0; y < 10; y++) headRow(y, (x) => {
      const isHair = y < 3 || x <= 6 || (y === 3 && x <= 9);
      p.set(x, y + bob, isHair ? (x <= 4 ? hairD : hair) : skin);
    });
    p.set(10, 5 + bob, DARK); p.set(10, 6 + bob, DARK);
    if (female) { for (let y = 10; y < 14; y++) { p.set(4, y, hairD); p.set(5, y, hair); } p.set(3, 9, hairD); }
    p.rect(6, 10, 5, female ? 4 : 7, top); p.rect(6, 10, 1, female ? 4 : 7, topD);
    if (female) { for (let y = 14; y < 18; y++) { const e = y - 14 > 1 ? 1 : 0; p.rect(5 - e, y, 7 + e * 2, 1, bottom); p.set(5 - e, y, botD); } }
    const ax = frame === 1 ? 9 : frame === 2 ? 7 : 8;
    p.rect(ax, 11, 2, 4, topD); p.rect(ax, 15, 2, 1, skin);
    const legTop = female ? 18 : 17, lc = female ? skin : bottom, lcD = female ? skinD : botD;
    if (frame === 1) {
      p.rect(9, legTop, 2, 21 - legTop, lc); p.rect(9, 21, 3, 1, shoe);
      p.rect(5, legTop, 2, 20 - legTop, lcD); p.rect(4, 20, 3, 1, shoe);
    } else if (frame === 2) {
      p.rect(7, legTop, 2, 21 - legTop, lc); p.rect(7, 21, 3, 1, shoe);
      p.rect(8, legTop, 2, 20 - legTop, lcD);
    } else {
      p.rect(7, legTop, 3, 21 - legTop, lc); p.set(7, legTop + 1, lcD); p.rect(7, 21, 4, 1, shoe);
    }
    return p.outlined(DARK);
  }

  // ---- 正面 / 背面 ----
  for (let y = 0; y < 10; y++) headRow(y, (x) => {
    let c;
    if (dir === 1) c = x >= 11 ? hairD : hair;
    else {
      const side = x === HEAD[y][0] || x === HEAD[y][1];
      const fringe = y < 3 || (y === 3 && (x < 7 || x > 10)) || (y === 4 && (x < 5 || x > 11));
      c = (side && y < 8) || fringe ? (x >= 11 ? hairD : hair) : skin;
    }
    p.set(x, y, c);
  });
  if (dir === 0) {
    p.set(5, 5, DARK); p.set(5, 6, DARK); p.set(10, 5, DARK); p.set(10, 6, DARK);
    p.set(7, 8, skinD); p.set(8, 8, skinD);
    if (female) { p.set(4, 7, '#f29aa0'); p.set(11, 7, '#f29aa0'); }
  } else { p.set(7, 9, skinD); p.set(8, 9, skinD); }
  // 身子、胳膊
  const armL = frame === 1 ? -1 : 0, armR = frame === 2 ? -1 : 0;
  p.rect(5, 10, 6, female ? 4 : 7, top); p.rect(10, 10, 1, female ? 4 : 7, topD);
  p.rect(4, 10, 1, 5 + armL, top); p.set(4, 15 + armL, skin);
  p.rect(11, 10, 1, 5 + armR, topD); p.set(11, 15 + armR, skin);
  if (female) {
    for (let y = 14; y < 18; y++) { const e = y > 15 ? 1 : 0; p.rect(4 - e, y, 8 + e * 2, 1, bottom); p.set(11 + e, y, botD); }
    // 长头发：正面垂在肩膀两边，背面盖住后背
    if (dir === 0) for (let y = 8; y < 13; y++) { p.set(3, y, hair); p.set(12, y, hairD); if (y > 9) { p.set(4, y, hair); p.set(11, y, hairD); } }
    else for (let y = 9; y < 14; y++) for (let x = 3; x <= 12; x++) p.set(x, y, x >= 10 ? hairD : hair);
  }
  // 腿、鞋
  const legTop = female ? 18 : 17, lc = female ? skin : bottom, lcD = female ? skinD : botD;
  if (!female) p.rect(5, 17, 6, 1, bottom);
  const lL = frame === 1 ? 1 : 0, lR = frame === 2 ? 1 : 0;
  p.rect(female ? 6 : 5, legTop, 2, 21 - legTop - lL, lc); p.rect(female ? 6 : 5, 21 - lL, 2, 1, shoe);
  p.rect(female ? 8 : 9, legTop, 2, 21 - legTop - lR, lcD); p.rect(female ? 8 : 9, 21 - lR, 2, 1, shoe);
  return p.outlined(DARK);
}

/**
 * 大公鸡（男用户在游戏里的样子）：24×24（描边后 26×26）。
 * dir：0 正面（朝屏幕外） 1 背面 2 朝右；frame：0 站 1、2 走 3 打鸣（抬头、张嘴）
 */
export function rooster(dir, frame) {
  const p = new Pix(24, 24);
  const RED = '#e23b3b', REDD = '#b52a34', BEAK = '#f6c13a', BEAKD = '#d9952b', LEG = '#e6a422';
  const BODY = '#c9772f', BODYL = '#e8a650', BODYD = '#9a5524', WING = '#7d4324', NECK = '#f3c04a', NECKD = '#d99a2b', HEAD = '#f7d06a';
  const TAIL = ['#16302e', '#1f4a44', '#2f6f5f', '#58a07a'];
  const ell = (cx, cy, rx, ry, c) => { for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) { const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry; if (nx * nx + ny * ny <= 1) p.set(x, y, typeof c === 'function' ? c(x, y) : c); } };
  const crow = frame === 3, up = crow ? -2 : 0;
  // 两条腿：走的时候一前一后、轮流抬起
  const leg = (x, lift, fwd) => { p.rect(x, 19, 1, 4 - lift, LEG); p.rect(x - 1 + fwd, 23 - lift, 3, 1, LEG); };

  if (dir === 2) {
    // ---- 侧面（朝右）：左边是翘起来的尾巴，右边是头 ----
    ell(3.5, 9.5, 3.2, 6, (x, y) => ((x + y) % 3 === 0 ? TAIL[2] : TAIL[1]));
    ell(5.5, 8, 2.6, 5.5, (x, y) => ((x + y) % 3 === 1 ? TAIL[3] : TAIL[2]));
    ell(2.5, 12, 2.3, 3.6, TAIL[0]);
    if (frame === 1) { leg(9, 1, -1); leg(14, 0, 1); } else if (frame === 2) { leg(10, 0, 1); leg(13, 1, -1); } else { leg(10, 0, 0); leg(13, 0, 0); }
    ell(11.5, 15, 6.6, 4.6, BODY);
    ell(13.5, 16.6, 3.6, 2.6, BODYL);
    ell(10, 15, 3.8, 2.7, (x, y) => (y < 14 ? BODYD : WING));
    for (let y = 13; y <= 16; y++) if ((y & 1) === 0) p.set(8 + (y - 13), y, BODYD);
    ell(15.6, 10.5 + up * 0.5, 2.7, 4.2, (x, y) => ((x + y * 2) % 3 === 0 ? NECKD : NECK));
    ell(17.2, 5.6 + up, 2.7, 2.7, HEAD);
    for (const [x, y] of [[15, 3], [16, 2], [16, 3], [17, 3], [18, 2], [18, 3], [19, 3], [16, 1], [18, 1], [17, 2]]) p.set(x, y + up, x % 2 ? RED : REDD);
    p.set(18, 5 + up, DARK);
    if (crow) { p.set(20, 3 + up, BEAK); p.set(21, 2 + up, BEAK); p.set(20, 4 + up, BEAKD); p.set(20, 6 + up, BEAK); p.set(21, 7 + up, BEAKD); p.set(20, 5 + up, '#7a1f2a'); }
    else { p.set(20, 5 + up, BEAK); p.set(21, 5 + up, BEAK); p.set(20, 6 + up, BEAKD); }
    p.set(19, 7 + up, RED); p.set(19, 8 + up, RED); p.set(20, 8 + up, REDD); p.set(19, 9 + up, REDD);
    return p.outlined(DARK);
  }

  const lf = frame === 1 ? 1 : 0, rf = frame === 2 ? 1 : 0;
  leg(10, lf, 0); leg(14, rf, 0);
  if (dir === 0) {
    // ---- 正面：尾巴在身后露出一圈，胸口朝前 ----
    ell(12, 9.5, 9, 7.2, (x, y) => (((Math.atan2(y - 16, x - 12) * 7) | 0) % 2 ? TAIL[1] : TAIL[2]));
    ell(12, 15.6, 6.2, 5.2, BODY);
    ell(6.6, 15.5, 1.9, 3.4, WING); ell(17.4, 15.5, 1.9, 3.4, BODYD);
    ell(12, 16.6, 3.6, 3.4, BODYL);
    ell(12, 10 + up * 0.5, 3.3, 3.6, (x, y) => ((x + y) % 3 === 0 ? NECKD : NECK));
    ell(12, 6.2 + up, 3.1, 2.9, HEAD);
    for (const [x, y] of [[10, 3], [11, 2], [11, 3], [12, 1], [12, 2], [12, 3], [13, 2], [13, 3], [14, 3]]) p.set(x, y + up, x % 2 ? REDD : RED);
    p.set(10, 6 + up, DARK); p.set(14, 6 + up, DARK);
    if (crow) { p.set(12, 7 + up, BEAK); p.set(11, 8 + up, BEAK); p.set(13, 8 + up, BEAK); p.set(12, 8 + up, '#7a1f2a'); p.set(12, 9 + up, BEAKD); }
    else { p.set(12, 7 + up, BEAK); p.set(12, 8 + up, BEAKD); }
    p.set(11, 9 + up, RED); p.set(13, 9 + up, RED); p.set(11, 10 + up, REDD); p.set(13, 10 + up, REDD);
  } else {
    // ---- 背面：一大把尾巴羽毛朝着你，上面露出一点鸡冠 ----
    ell(12, 16.4, 6.2, 4.8, (x, y) => (x < 8 || x > 15 ? BODYD : BODY));
    ell(12, 5.4 + up, 3, 2.9, (x, y) => ((x + y) % 3 === 0 ? NECKD : HEAD));
    for (const [x, y] of [[10, 2], [11, 1], [11, 2], [12, 0], [12, 1], [12, 2], [13, 1], [13, 2], [14, 2]]) p.set(x, y, x % 2 ? REDD : RED);   // 鸡冠贴着画布顶，打鸣时头抬高、把它顶住
    ell(12, 12.4, 8.4, 6.4, (x, y) => { const k = ((Math.atan2(y - 19, x - 12) * 8) | 0) % 2; return y < 8 ? TAIL[3] : k ? TAIL[1] : TAIL[2]; });
    ell(12, 16.4, 2.6, 2.2, TAIL[0]);
  }
  return p.outlined(DARK);
}

/** 把很多小块拼到一张大图上（一次上传给显卡），记下每块的位置 */
export class Atlas {
  constructor(size = 512) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.x = 1; this.y = 1; this.rowH = 0; this.map = {};
  }
  add(name, pix) {
    if (this.x + pix.w + 1 > this.size) { this.x = 1; this.y += this.rowH + 1; this.rowH = 0; }
    if (this.y + pix.h + 1 > this.size) throw new Error('图集放不下了：' + name);
    this.ctx.putImageData(new ImageData(pix.d, pix.w, pix.h), this.x, this.y);
    // 贴图上下是反的（画布左上角 = 贴图左上角 v=1）
    const S = this.size;
    this.map[name] = { u0: this.x / S, u1: (this.x + pix.w) / S, v0: 1 - (this.y + pix.h) / S, v1: 1 - this.y / S, w: pix.w, h: pix.h };
    this.x += pix.w + 1; this.rowH = Math.max(this.rowH, pix.h);
    return this.map[name];
  }
}
