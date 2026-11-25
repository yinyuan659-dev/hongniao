// 相亲物语 · 样稿原型 —— 主程序。只是给样稿截图和试玩用的，不是产品代码。
// 打包：双击 build.cmd（esbuild 把 src\ 下的文件打成一个 game.js；three.js 取自引擎目录，只读）。
// 网址参数（截图用）：scene=sakura|ginkgo|pine|lantern  t=day|dusk|night  w=clear|rain|snow  x= z= 玩家位置  dir=0|1|2|3
//   tx= tz= 走向的目标  joy=1 显示摇杆  menu=1 打开场景菜单  ui=0 不显示下面的调试条  freeze=1 画面定住  px=2 一个像素块占几个屏幕点
//   pitch= fov= dist= ahead= 调镜头（横屏用 pitchl= fovl= distl= aheadl=）
import * as THREE from 'three';
import { Atlas, PAL, roundTree, pine, clump, wishTree, flower, tuft, litter, stall, lantern, bench, person, portrait, toURL, rgb, rng } from './pix.js';
import { SCENES, buildScene, heightAt } from './scenes.js';

THREE.ColorManagement.enabled = false;
const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const PIX = num('px', 2);
const FREEZE = Q.get('freeze') === '1';

// ---------- 镜头：固定朝北、斜着往下看，跟着玩家平移，不旋转。竖屏、横屏各一套参数 ----------
const CAMS = {
  port: { pitch: num('pitch', 44), fov: num('fov', 60), dist: num('dist', 34), ahead: num('ahead', 13) },
  land: { pitch: num('pitchl', 36), fov: num('fovl', 40), dist: num('distl', 30), ahead: num('aheadl', 8) },
};
let CAM = CAMS.port, PITCH = (CAM.pitch * Math.PI) / 180;

const root = document.getElementById('game');
const canvas = document.getElementById('cv');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAM.fov, 1, 1, 560);
let W = 360, H = 640, LW = 180, LH = 320;
let rt = new THREE.WebGLRenderTarget(4, 4);

// ---------- 时间和天气的配色 ----------
const TIMES = {
  day: { name: '白天', top: '#4f93cf', mid: '#8fc3e6', hor: '#d9eef2', fog: '#cfe4ea', sun: [1.0, 0.96, 0.86], ambS: [0.66, 0.74, 0.84], ambG: [0.44, 0.44, 0.38], cl: '#ffffff', cm: '#e6eef6', cs: '#b9cde0', disc: '#fff6d8', glow: [1.0, 0.95, 0.7], glowK: 0.22, stars: 0, night: 0, win: 0, sunPos: [0.47, 0.15] },
  dusk: { name: '黄昏', top: '#5f5488', mid: '#b97f9f', hor: '#f2b48c', fog: '#c896a2', sun: [1.12, 0.76, 0.5], ambS: [0.64, 0.52, 0.64], ambG: [0.42, 0.32, 0.34], cl: '#f9cfae', cm: '#dc9ca8', cs: '#8e6f98', disc: '#ffe6a8', glow: [1.0, 0.6, 0.34], glowK: 0.6, stars: 0.12, night: 0.22, win: 0.75, sunPos: [0.47, 0.125] },
  night: { name: '夜晚', top: '#0f1433', mid: '#1c2450', hor: '#343a6e', fog: '#1b2146', sun: [0.3, 0.38, 0.62], ambS: [0.2, 0.25, 0.44], ambG: [0.1, 0.1, 0.19], cl: '#4a5288', cm: '#343c6c', cs: '#232a52', disc: '#f4f1dc', glow: [0.55, 0.65, 1.0], glowK: 0.22, stars: 1, night: 1, win: 1, sunPos: [0.47, 0.15] },
};
const WEATHER = {
  clear: { name: '晴', cloud: 0.42, rain: 0, fall: 0, snow: 0, fogNear: 75, fogFar: 330, dim: 1, gray: 0, wet: 0 },
  rain: { name: '雨', cloud: 1, rain: 1, fall: 0, snow: 0, fogNear: 22, fogFar: 125, dim: 0.66, gray: 0.7, wet: 1 },
  snow: { name: '雪', cloud: 0.95, rain: 0, fall: 1, snow: 1, fogNear: 28, fogFar: 150, dim: 0.9, gray: 0.55, wet: 0 },
};
let SC = SCENES.find((s) => s.id === Q.get('scene')) || SCENES[0];
let timeKey = TIMES[Q.get('t')] ? Q.get('t') : SC.time, weatherKey = WEATHER[Q.get('w')] ? Q.get('w') : SC.weather;
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

function makeEnv(tk, wk) {
  const T = TIMES[tk], Wt = WEATHER[wk], snowy = Wt.snow;
  const gray = (c, lift = 0) => { const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11 + lift; return mix3(c, [l * 0.93, l * 0.97, l * 1.06], Wt.gray); };
  const lift = snowy ? 0.12 * (1 - T.night * 0.8) : 0;
  const sun = mul3(T.sun, Wt.dim * (1 - Wt.gray * 0.45));
  const ambS = mul3(gray(T.ambS), 0.92 + snowy * 0.12), ambG = mul3(gray(T.ambG), 0.95 + snowy * 0.2);
  // 飘落物：下雪时是雪，否则是这个场景自己的花瓣 / 落叶（下雨时没有）
  const flakeAmt = Wt.fall ? 1 : Wt.rain ? 0 : SC.fall;
  const flake = Wt.fall ? [1, 1, 1] : SC.flake.map((c) => c * (1 - T.night * 0.45));
  return {
    top: mul3(gray(rgb(T.top), lift), Wt.dim + (1 - Wt.dim) * 0.35), mid: mul3(gray(rgb(T.mid), lift), Wt.dim + (1 - Wt.dim) * 0.4), hor: mul3(gray(rgb(T.hor), lift * 0.5), Wt.dim + (1 - Wt.dim) * 0.45),
    fog: mul3(gray(rgb(T.fog), lift), Wt.dim + (1 - Wt.dim) * 0.45),
    sun, ambS, ambG,
    spr: [ambS[0] * 0.82 + sun[0] * 0.5, ambS[1] * 0.82 + sun[1] * 0.5, ambS[2] * 0.82 + sun[2] * 0.5],
    cl: gray(rgb(T.cl)).map((c) => c * (Wt.rain ? 0.7 : 1)), cm: gray(rgb(T.cm)).map((c) => c * (Wt.rain ? 0.66 : 1)), cs: gray(rgb(T.cs)).map((c) => c * (Wt.rain ? 0.7 : 1)),
    disc: rgb(T.disc), glow: T.glow.slice(), flake,
    s: [Wt.cloud, Wt.rain, flakeAmt, Wt.snow, Wt.fogNear, Wt.fogFar, Wt.wet, T.stars * (1 - Wt.gray), T.night, T.win, T.glowK * (1 - Wt.gray), 1 - Wt.gray, T.sunPos[0], T.sunPos[1], Wt.fall ? 0 : 1],
  };
}
let env = makeEnv(timeKey, weatherKey);
function stepEnv(k) {
  const tg = makeEnv(timeKey, weatherKey);
  for (const key of Object.keys(tg)) for (let i = 0; i < tg[key].length; i++) env[key][i] += (tg[key][i] - env[key][i]) * k;
}

// ---------- 着色器 ----------
const SUN_DIR = new THREE.Vector3(-0.72, 0.5, 0.42).normalize();
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const sharedU = {
  uTime: { value: 0 }, uSunDir: { value: SUN_DIR }, uSunCol: { value: V3(env.sun) }, uAmbSky: { value: V3(env.ambS) }, uAmbGnd: { value: V3(env.ambG) },
  uFogCol: { value: V3(env.fog) }, uFogNear: { value: 70 }, uFogFar: { value: 240 }, uSnow: { value: 0 }, uWet: { value: 0 }, uNight: { value: 0 }, uWin: { value: 0 },
  uLights: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -99, 0, 1)) }, uLightCol: { value: new THREE.Vector3(1.0, 0.62, 0.3) },
  uShadows: { value: Array.from({ length: 12 }, () => new THREE.Vector3(0, 0, -1)) },
  uMark: { value: new THREE.Vector4(0, 0, 0, 0) }, uSprLight: { value: V3(env.spr) },
  uMe: { value: new THREE.Vector4(0, 0, 0, 0) }, uRes: { value: new THREE.Vector2(180, 320) }, uPD: { value: 20 },
  uRoad: { value: new THREE.Vector4(2.6, 10, -60, 1) }, uRoadA: { value: new THREE.Vector3(0.9, 0.86, 0.8) }, uRoadB: { value: new THREE.Vector3(0.85, 0.8, 0.72) }, uEnd: { value: new THREE.Vector3(0, -70, 7) }, uStretch: { value: 1 },
};

const worldMat = new THREE.ShaderMaterial({
  uniforms: sharedU, side: THREE.DoubleSide,
  vertexShader: `
    attribute vec3 aCol; attribute float aH; attribute float aMat;
    varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vMat; varying float vD;
    void main(){
      vCol = aCol; vN = normal; vMat = aMat;
      vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
      vec4 mv = viewMatrix * w; vD = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    precision highp float;
    varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying float vMat; varying float vD;
    uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGnd, uFogCol, uLightCol, uRoadA, uRoadB, uEnd;
    uniform float uFogNear, uFogFar, uSnow, uWet, uNight, uWin, uTime, uPD;
    uniform vec4 uLights[8]; uniform vec3 uShadows[12]; uniform vec4 uMark; uniform vec4 uMe; uniform vec4 uRoad;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float m2(vec2 p){ return p.y < 0.5 ? (p.x < 0.5 ? 0.0 : 2.0) : (p.x < 0.5 ? 3.0 : 1.0); }
    void main(){
      vec3 N = normalize(vN);
      vec3 alb = vCol; float land = step(vMat, 0.5); float paved = 0.0;
      // 比玩家离镜头更近的房子：一点一点淡掉，不挡画面
      if (land < 0.5) { vec2 q = mod(floor(gl_FragCoord.xy), 4.0); if ((4.0 * m2(mod(q, 2.0)) + m2(floor(q / 2.0)) + 0.5) / 16.0 > smoothstep(uPD - 9.0, uPD - 3.5, vD)) discard; }
      if (land > 0.5) {
        // 路：一块一块错缝铺的石板，两边一条深色的路沿；路尽头大树下是一圈同样的铺地
        float ax = abs(vW.x);
        float onRoad = step(ax, uRoad.x + 0.3) * step(vW.z, uRoad.y) * step(uRoad.z, vW.z);
        float onEnd = step(length(vW.xz - uEnd.xy), uEnd.z);
        if (onRoad + onEnd > 0.5) {
          paved = 1.0;
          float col = floor((vW.x + 60.0) / 1.3);
          vec2 uvt = vec2((vW.x + 60.0) / 1.3, (vW.z + mod(col, 2.0) * 0.65) / 1.3);
          alb = mix(uRoadA, uRoadB, step(0.55, hash(floor(uvt))));
          vec2 f = fract(uvt);
          if (f.x < 0.07 || f.y < 0.07) alb *= 0.88;
          if (onRoad > 0.5 && onEnd < 0.5 && ax > uRoad.x) alb = uRoadB * 0.78;
        }
        // 点地面时的目标圈、玩家脚下的圈
        float dm = length(vW.xz - uMark.xy);
        alb = mix(alb, vec3(1.0, 0.24, 0.39), uMark.w * max(step(abs(dm - uMark.z), 0.2), step(dm, 0.26)));
        float de = length(vW.xz - uMe.xy);
        alb = mix(alb, vec3(1.0, 0.24, 0.39), uMe.w * step(abs(de - 0.95), 0.11));
        // 地面加一点颗粒，不然大片颜色太糊
        if (paved < 0.5) alb *= 1.0 + (hash(floor(vW.xz * 2.6)) - 0.5) * 0.1 + (hash(floor(vW.xz * 0.9) + 7.0) - 0.5) * 0.05;
      }
      // 积雪：朝上的面变白；路上薄一点，能看出是路
      float sn = uSnow * smoothstep(0.3, 0.75, N.y) * step(vMat, 1.5) * (1.0 - paved * 0.45);
      sn *= 0.86 + 0.14 * step(0.2, hash(floor(vW.xz * 3.1)));
      alb = mix(alb, vec3(0.93, 0.94, 0.99), sn * 0.92);
      alb *= 1.0 - uWet * 0.2;
      float ndl = max(dot(N, uSunDir), 0.0);
      vec3 lit = alb * (mix(uAmbGnd, uAmbSky, N.y * 0.5 + 0.5) + uSunCol * ndl * 0.85);
      // 人脚下的影子
      if (land > 0.5) {
        float sh = 0.0;
        for (int i = 0; i < 12; i++) { vec3 s = uShadows[i]; vec2 d2 = (vW.xz - s.xy) * vec2(1.0, 1.7); sh = max(sh, step(length(d2), s.z)); }
        lit *= 1.0 - 0.3 * sh;
      }
      // 灯笼、窗户的暖光
      vec3 pl = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        vec3 L = uLights[i].xyz - vW; float d = length(L);
        float a = max(0.0, 1.0 - d / uLights[i].w); a *= a;
        pl += uLightCol * a * (0.55 + 0.45 * max(dot(N, L / max(d, 0.001)), 0.0));
      }
      lit += alb * pl * uNight * 1.5;
      if (vMat > 1.5) lit = mix(lit, vec3(1.0, 0.8, 0.42), uWin);
      float f = smoothstep(uFogNear, uFogFar, vD);
      gl_FragColor = vec4(mix(lit, uFogCol, f), 1.0);
    }`,
});

const spriteMat = new THREE.ShaderMaterial({
  uniforms: { ...sharedU, uTex: { value: null }, uPlayer: { value: new THREE.Vector4(0, 0, 0, 0) } },
  vertexShader: `
    attribute vec3 iPos; attribute vec4 iUV; attribute vec3 iSize;
    varying vec2 vUv; varying float vLy; varying float vD; varying float vFlag; varying vec3 vPl; varying float vBaseD;
    uniform vec4 uLights[8]; uniform vec3 uLightCol; uniform float uNight; uniform float uStretch;
    void main(){
      vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      // 镜头越俯，竖着的贴片看起来越扁，这里按角度拉高补回来
      vec3 w = iPos + right * (position.x * iSize.x) + vec3(0.0, position.y * iSize.y * uStretch, 0.0);
      vec4 mv = viewMatrix * vec4(w, 1.0);
      vD = -mv.z; vBaseD = -(viewMatrix * vec4(iPos, 1.0)).z;
      gl_Position = projectionMatrix * mv;
      vUv = vec2(mix(iUV.x, iUV.z, position.x + 0.5), mix(iUV.y, iUV.w, position.y));
      vLy = position.y; vFlag = iSize.z;
      vec3 pl = vec3(0.0);
      for (int i = 0; i < 8; i++) { float d = length(uLights[i].xyz - (iPos + vec3(0.0, 1.0, 0.0))); float a = max(0.0, 1.0 - d / uLights[i].w); pl += uLightCol * a * a; }
      vPl = pl * uNight * 1.4;
    }`,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv; varying float vLy; varying float vD; varying float vFlag; varying vec3 vPl; varying float vBaseD;
    uniform sampler2D uTex; uniform vec3 uSprLight, uFogCol; uniform float uFogNear, uFogFar, uSnow, uWet; uniform vec4 uPlayer; uniform vec2 uRes;
    void main(){
      vec4 t = texture2D(uTex, vUv);
      if (t.a < 0.5) discard;
      // 比玩家离镜头更近的树、摊位：一点一点淡掉，不挡画面（只有贴片类型 0 会淡；人、灯、路尽头的大树不淡）
      if (vFlag < 0.2) {
        vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
        float m2a = mod(q.y, 2.0) < 0.5 ? (mod(q.x, 2.0) < 0.5 ? 0.0 : 2.0) : (mod(q.x, 2.0) < 0.5 ? 3.0 : 1.0);
        vec2 q2 = floor(q / 2.0);
        float m2b = q2.y < 0.5 ? (q2.x < 0.5 ? 0.0 : 2.0) : (q2.x < 0.5 ? 3.0 : 1.0);
        if ((4.0 * m2a + m2b + 0.5) / 16.0 > smoothstep(uPlayer.z - 5.0, uPlayer.z - 2.5, vBaseD)) discard;
      }
      vec3 c = t.rgb;
      if (vFlag > 0.5 && vFlag < 1.5) { // 灯笼：自己发光
        c = c * (0.8 + 0.4 * step(0.6, vLy));
      } else {
        float isPerson = step(1.5, vFlag) * step(vFlag, 2.5);
        float sn = uSnow * (1.0 - isPerson) * smoothstep(0.55, 0.95, vLy + (fract(sin(dot(floor(vUv * 1024.0), vec2(12.9, 78.2))) * 43758.5) - 0.5) * 0.35);
        c = mix(c, vec3(0.93, 0.94, 0.99), sn * 0.85);
        c *= 1.0 - uWet * 0.15;
        c = c * (uSprLight + vPl);
      }
      float f = smoothstep(uFogNear, uFogFar, vD);
      gl_FragColor = vec4(mix(c, uFogCol, f), 1.0);
    }`,
});

// 最后一遍：天空（渐变、太阳或月亮、云、星星）+ 雨 + 飘落物（雪 / 花瓣 / 落叶）+ 点阵过渡、压成有限的色阶
const postU = {
  tScene: { value: null }, uRes: sharedU.uRes, uTime: sharedU.uTime, uHorizon: { value: 0.9 },
  uTop: { value: V3(env.top) }, uMid: { value: V3(env.mid) }, uHor: { value: V3(env.hor) },
  uCl: { value: V3(env.cl) }, uCm: { value: V3(env.cm) }, uCs: { value: V3(env.cs) }, uDisc: { value: V3(env.disc) }, uGlow: { value: V3(env.glow) }, uFlake: { value: V3(env.flake) },
  uCloud: { value: 0.4 }, uRain: { value: 0 }, uFall: { value: 0 }, uPetal: { value: 0 }, uStars: { value: 0 }, uGlowK: { value: 0.5 }, uSunVis: { value: 1 }, uSunPos: { value: new THREE.Vector2(0.47, 0.13) }, uLevels: { value: num('levels', 20) },
};
const postMat = new THREE.ShaderMaterial({
  uniforms: postU, depthTest: false, depthWrite: false,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `
    precision highp float;
    varying vec2 vUv; uniform sampler2D tScene; uniform vec2 uRes; uniform float uTime, uHorizon, uCloud, uRain, uFall, uPetal, uStars, uGlowK, uSunVis, uLevels;
    uniform vec3 uTop, uMid, uHor, uCl, uCm, uCs, uDisc, uGlow, uFlake; uniform vec2 uSunPos;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
    float fbm(vec2 p){ return vn(p) * 0.5 + vn(p * 2.03) * 0.25 + vn(p * 4.1) * 0.125 + vn(p * 8.3) * 0.0625; }
    float m2(vec2 p){ return p.y < 0.5 ? (p.x < 0.5 ? 0.0 : 2.0) : (p.x < 0.5 ? 3.0 : 1.0); }
    float bayer(vec2 p){ vec2 q = mod(p, 4.0); return (4.0 * m2(mod(q, 2.0)) + m2(floor(q / 2.0)) + 0.5) / 16.0; }
    vec3 sky(vec2 uv){
      float asp = uRes.x / uRes.y;
      float span = max(1.0 - uHorizon, 0.001);
      float t = (uv.y - uHorizon) / span;
      if (t < 0.0) return uHor;
      vec3 c = mix(uHor, uMid, smoothstep(0.0, 0.5, t)); c = mix(c, uTop, smoothstep(0.4, 1.15, t));
      // 太阳 / 月亮：放在天空这一条的中间偏上
      vec2 sp = vec2(uSunPos.x, uHorizon + span * 0.62);
      float d = length((uv - sp) * vec2(asp, 1.0));
      c += uGlow * uGlowK * exp(-d * 9.0);
      c = mix(c, uDisc, step(d, 0.019) * uSunVis);
      float st = step(0.992, hash(floor(uv * uRes))) * uStars * step(0.12, t);
      c += st * (0.6 + 0.4 * sin(uTime * 2.0 + uv.x * 90.0));
      // 云：噪声切三档（亮面 / 中间 / 暗底）
      vec2 p = vec2(uv.x * asp * 5.0 + uTime * 0.012, t * 3.2);
      float n = fbm(p * vec2(1.0, 2.6) + vec2(0.0, 3.0)) + (0.5 - abs(t - 0.5)) * 0.25;
      float dens = n - (0.78 - uCloud * 0.34);
      if (dens > 0.0) {
        float up = fbm(p * vec2(1.0, 2.6) + vec2(0.0, 3.22)) - n;
        c = dens > 0.11 ? (up < 0.0 ? uCl : uCm) : dens > 0.045 ? uCm : uCs;
      }
      return c;
    }
    void main(){
      vec2 px = floor(vUv * uRes); vec2 uv = (px + 0.5) / uRes;
      vec4 s = texture2D(tScene, uv);
      vec3 c = s.a < 0.5 ? sky(uv) : s.rgb;
      // 雨：斜着的短线
      if (uRain > 0.01) {
        float acc = 0.0;
        for (int L = 0; L < 2; L++) {
          float fl = float(L); vec2 q = px; q.x += q.y * 0.3;
          float col = floor(q.x / (2.0 + fl)); float sp = 150.0 + hash(vec2(col, fl)) * 130.0;
          float y = q.y + uTime * sp * (1.0 + fl * 0.4) + hash(vec2(col * 7.0, fl)) * 500.0;
          float seg = mod(y, 70.0 + hash(vec2(col * 3.0, fl + 2.0)) * 90.0);
          acc += step(seg, 6.0 + 4.0 * fl) * step(0.55, hash(vec2(col * 13.0, fl + 5.0))) * (0.55 - 0.2 * fl);
        }
        c = mix(c, vec3(0.78, 0.84, 0.95), acc * 0.6 * uRain);
      }
      // 飘落物：三层，近的大、落得快。雪直着落；花瓣和落叶（uPetal = 1）斜着飘、晃得更厉害、稀一点
      if (uFall > 0.01) {
        for (int L = 0; L < 3; L++) {
          float fl = float(L); float size = 13.0 + fl * 9.0 + uPetal * 8.0;
          vec2 q = vec2(px.x + sin(uTime * 0.7 + px.y * 0.03 + fl * 2.0) * (2.0 + fl) * (1.0 + uPetal * 2.0) + uPetal * uTime * (5.0 + fl * 3.0), px.y + uTime * (16.0 + fl * 13.0) * (1.0 - uPetal * 0.45));
          vec2 cell = floor(q / size), f = fract(q / size) * size;
          vec2 ctr = (vec2(hash(cell + fl * 17.0), hash(cell.yx + fl * 31.0)) * 0.7 + 0.15) * size;
          float r = 0.7 + fl * 0.45;
          if (hash(cell + 3.3 + fl) > 1.0 - 0.7 * uFall && abs(f.x - ctr.x) < r + uPetal * 0.5 && abs(f.y - ctr.y) < r) c = mix(c, uFlake, 0.92);
        }
      }
      c = floor(c * uLevels + bayer(px)) / uLevels;
      gl_FragColor = vec4(c, 1.0);
    }`,
});
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat); postQuad.frustumCulled = false; postScene.add(postQuad);

// ---------- 把贴片都画出来，拼成一张图 ----------
const atlas = new Atlas(1024);
['red', 'orange', 'yellow', 'olive'].forEach((k, ki) => { for (let i = 0; i < 3; i++) atlas.add(`tree_${k}_${i}`, roundTree(100 + ki * 10 + i, PAL[k], 34 + i * 2, 42 + i * 2)); });
for (let i = 0; i < 4; i++) atlas.add('sak' + i, roundTree(500 + i, i % 2 ? PAL.sakura2 : PAL.sakura, 38 + i * 2, 44 + i * 2, 10));
for (let i = 0; i < 3; i++) atlas.add('pine' + i, pine(200 + i, PAL.pine, 20 + i * 2, 44 + i * 3));
atlas.add('wish', wishTree(7)); atlas.add('gk_big', roundTree(77, PAL.yellow, 84, 92, 22)); atlas.add('pine_big', pine(78, PAL.pine, 46, 96));
atlas.add('rock1', clump(312, PAL.rock, 10, 7));
atlas.add('fl_pink', flower('#f093ad')); atlas.add('fl_white', flower('#fff4e6')); atlas.add('fl_yellow', flower('#f6d24a', '#e2683a')); atlas.add('fl_red', flower('#e2483a'));
for (let i = 0; i < 3; i++) atlas.add('tuft' + i, tuft(400 + i, i === 2 ? '#8a7a3a' : '#5f7a3c', i === 2 ? '#c2a03c' : '#93a850'));
atlas.add('petal', litter(41, '#ffd3e0', '#f7a8c0')); atlas.add('leaf', litter(42, '#f3c84a', '#d9a22b'));
atlas.add('stall0', stall(1, '#d9534a')); atlas.add('stall1', stall(2, '#3f8f96', ['#f6ead0', '#e2c13e', '#d96b8f'])); atlas.add('stall2', stall(3, '#d99a2b', ['#7fae4a', '#e2483a', '#b98552']));
atlas.add('lantern', lantern()); atlas.add('bench', bench());

// 人物的长相。第 0 个是玩家自己（样稿里按男用户画），其余是路两边的人
const LOOKS = [{ skin: '#f2c9a4', hair: '#2e2530', top: '#4a78b8', bottom: '#3a4460', female: false }];
{
  const r = rng(99), pick = (a) => a[(r() * a.length) | 0];
  for (let i = 0; i < 10; i++) LOOKS.push({
    skin: pick(['#f6d3b4', '#f3ccaa', '#f8d8bd', '#efc6a2']), hair: pick(['#33262a', '#5a3a2e', '#2a2430', '#3a2c36', '#6b3f2e', '#7a4a32']),
    top: pick(['#f6ead0', '#7fae8a', '#f39a5a', '#b79ad6', '#ffd24a', '#ffffff', '#f093ad', '#8fc3e6']), bottom: pick(['#d96b8f', '#f6ead0', '#3f5f8f', '#5a4a7a', '#e2683a', '#3f8f96', '#c9a227']), female: true,
  });
}
LOOKS.forEach((lk, ci) => {
  for (let f = 0; f < 3; f++) {
    atlas.add(`ch${ci}_0_${f}`, person(lk, 0, f)); atlas.add(`ch${ci}_1_${f}`, person(lk, 1, f));
    const side = person(lk, 2, f); atlas.add(`ch${ci}_2_${f}`, side); atlas.add(`ch${ci}_3_${f}`, side.mirrored());
  }
});
const tex = new THREE.CanvasTexture(atlas.canvas);
tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
spriteMat.uniforms.uTex.value = tex;
/** 每种贴片：图上多少个像素等于世界里 1 米 */
const density = (n) => (n.startsWith('ch') ? 10.5 : n === 'wish' || n === 'gk_big' || n === 'pine_big' ? 8 : n.startsWith('tree') || n.startsWith('pine') || n.startsWith('sak') ? 9 : n.startsWith('fl') || n.startsWith('tuft') || n === 'petal' || n === 'leaf' ? 11 : 9);

function billboards(count, dynamic) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const a = { iPos: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3), iUV: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4), iSize: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3) };
  for (const k of Object.keys(a)) { if (dynamic) a[k].setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a[k]); }
  g.instanceCount = count;
  const m = new THREE.Mesh(g, spriteMat); m.frustumCulled = false; scene.add(m);
  return { g, a, m };
}
function setBB(bb, i, name, x, y, z, k = 1, flag = 0) {
  const r = atlas.map[name], d = density(name);
  bb.a.iPos.setXYZ(i, x, y, z); bb.a.iUV.setXYZW(i, r.u0, r.v0, r.u1, r.v1); bb.a.iSize.setXYZ(i, (r.w / d) * k, (r.h / d) * k, flag);
}
function mesh(d, indexed) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(d.nor, 3));
  g.setAttribute('aCol', new THREE.BufferAttribute(d.col, 3)); g.setAttribute('aH', new THREE.BufferAttribute(d.aH, 1)); g.setAttribute('aMat', new THREE.BufferAttribute(d.aMat, 1));
  if (indexed) g.setIndex(new THREE.BufferAttribute(d.idx, 1));
  const m = new THREE.Mesh(g, worldMat); m.frustumCulled = false; scene.add(m); return m;
}

// ---------- 假数据：名字、一句话、共同点都是编的 ----------
const NAMES = '小林 阿禾 安然 书瑶 可欣 晓雯 思琪 雨桐 梓涵 佳怡 诗涵 欣妍 雅婷 梦瑶 一诺 若曦 静怡 语嫣 婉清 子衿 念念 知夏 南乔 青禾 小满 十七 糖糖 阿宁 木子 清欢 晚晚 予安 星遥 朝颜 夏至 半夏 云舒 时雨 柚子 小鹿 橙子 阿茶 棠棠 七七 苏苏 可可 米粒 阿离 初见 听雨'.split(' ');
const SAYS = ['开朗爱笑，会做饭，周末爱往外跑', '慢热，喜欢在茶馆坐一下午，想找个聊得来的人', '每天晨跑五公里，做事有计划', '爱看书，话不多，但很会照顾人', '爱拍照爱旅行，去过十二个省', '爱热闹，朋友多，周末常约人逛集市', '工作认真，下班喜欢自己做顿好的', '养了一只猫，喜欢安静的小日子', '喜欢爬山和露营，想找个能一起出门的人', '性格直，有话当面说，不喜欢猜', '会弹一点吉他，周末常去看演出', '顾家，和父母关系好，想两年内结婚'];
const COMMON = [['同城', '都爱做饭'], ['同城'], ['都想两年内结婚'], ['同城', '都爱运动'], ['都爱旅行'], ['都喜欢安静'], ['同城', '都爱看书'], ['都爱小动物']];
const PHOTOS = { 0: '../img/f1.jpg', 13: '../img/f2.jpg', 24: '../img/f3.jpg' };   // 只有这三位用示意照片，其余是代码画的像素头像

// ---------- 场景 ----------
let world = null, terrainMesh = null, buildMesh = null, statics = null, NPCS = [];
const chars = billboards(600, true);
const ov = document.getElementById('ov');
const bub = document.createElement('div'); bub.className = 'bub'; bub.innerHTML = '<div class="say"></div><div class="tags"></div><div class="hi">打招呼</div>'; ov.appendChild(bub);
const meEl = document.createElement('div'); meEl.className = 'me'; meEl.textContent = '我'; ov.appendChild(meEl);
let bubFor = null;
bub.querySelector('.hi').addEventListener('click', (e) => { e.stopPropagation(); if (bubFor) toast(`这里打开和「${bubFor.name}」的聊天：没互相喜欢时最多先发 3 条`); });
for (const t of ['pointerdown', 'pointerup']) bub.addEventListener(t, (e) => e.stopPropagation());

const player = { x: 0, z: 3.5, dir: 1, frame: 0, look: 0, anim: 0, target: null, moving: false };
const cam = { x: 0, z: 3.5 };
let buildMs = 0;
function loadScene(S, keepEnv) {
  const t0 = performance.now();
  SC = S;
  for (const m of [terrainMesh, buildMesh, statics && statics.m]) if (m) { scene.remove(m); m.geometry.dispose(); }
  for (const n of NPCS) n.el.remove();
  world = buildScene(S);
  terrainMesh = mesh(world.terrain, true); buildMesh = mesh(world.build, false);
  statics = billboards(world.sprites.length, false);
  world.sprites.forEach((s, i) => setBB(statics, i, s.s, s.x, heightAt(s.x, s.z, world.cz) + (s.dy || 0), s.z, s.k, s.flag));
  const r = rng(31 + S.count);
  NPCS = world.people.map((p, i) => {
    const name = NAMES[(r() * NAMES.length) | 0], look = 1 + ((r() * 10) | 0);
    const n = { i, name, age: 23 + ((r() * 11) | 0), x: p.x, z: p.z, look, real: r() > 0.25, say: SAYS[(r() * SAYS.length) | 0], common: COMMON[(r() * COMMON.length) | 0], photo: PHOTOS[i] || toURL(portrait(9000 + i * 7 + S.count)), pixel: !PHOTOS[i], shown: true, cls: '', size: 0, sx: 0, sy: 0, depth: 0 };
    const el = document.createElement('div'); el.className = 'npc';
    el.innerHTML = `<div class="avw"><div class="av${n.pixel ? ' px' : ''}" style="background-image:url(${n.photo})"></div>${n.real ? '<i class="real"></i>' : ''}</div><div class="nm">${n.name} ${n.age}</div>`;
    el.querySelector('.avw').addEventListener('click', (e) => { e.stopPropagation(); toast(`这里打开「${n.name}」的完整画像页（现有页面）`); });
    for (const t of ['pointerdown', 'pointerup']) el.addEventListener(t, (e) => { if (e.target.closest('.avw')) e.stopPropagation(); });
    ov.appendChild(el); n.el = el;
    return n;
  });
  NPCS.forEach((n, i) => setBB(chars, i + 1, `ch${n.look}_0_0`, n.x, 1, n.z, 1, 2));
  chars.g.instanceCount = NPCS.length + 1;
  const U = sharedU, R = world.road;
  U.uRoad.value.set(R.hw, R.zS, R.zN, 1); U.uRoadA.value.fromArray(rgb(S.roadA)); U.uRoadB.value.fromArray(rgb(S.roadB)); U.uEnd.value.set(R.endX, R.endZ, R.endR);
  player.x = num('x', 0); player.z = num('z', -9); player.dir = num('dir', 1); player.target = null;
  cam.x = player.x; cam.z = player.z;
  if (!keepEnv) { timeKey = S.time; weatherKey = S.weather; }
  env = makeEnv(timeKey, weatherKey);
  document.getElementById('hud-name').textContent = S.name;
  document.getElementById('hud-count').textContent = NPCS.length + ' 人';
  buildMs = Math.round(performance.now() - t0);
  syncUI();
}

let toastT = 0;
function toast(s) { const t = document.getElementById('toast'); t.textContent = s; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200); }

// ---------- 操作：点地面走过去；按住拖动 = 摇杆 ----------
const joyEl = document.getElementById('joy'), joyKnob = joyEl.firstElementChild;
const menu = document.getElementById('menu'), dbg = document.getElementById('dbg');
const input = { down: false, sx: 0, sy: 0, joy: false, jx: 0, jz: 0, id: -1, fake: false };
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pickGround(cx, cy) {
  const r = root.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y >= -0.001) return null;
  const t = (1 - o.y) / d.y;                      // 地是平的（高度 1），直接求交点
  return { x: o.x + d.x * t, z: o.z + d.z * t };
}
const clampPos = (p) => { const b = world.bounds; return { x: Math.max(-b.x, Math.min(b.x, p.x)), z: Math.max(b.zN, Math.min(b.zS, p.z)) }; };
const mark = { x: 0, z: 0, a: 0 };
root.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#dbg,#hud,#menu')) return;
  input.down = true; input.sx = e.clientX; input.sy = e.clientY; input.joy = false; input.id = e.pointerId;
  document.getElementById('hint').classList.add('off'); menu.classList.remove('on');
});
root.addEventListener('pointermove', (e) => {
  if (!input.down || e.pointerId !== input.id) return;
  const dx = e.clientX - input.sx, dy = e.clientY - input.sy, l = Math.hypot(dx, dy);
  if (!input.joy && l > 12) { input.joy = true; player.target = null; const r = root.getBoundingClientRect(); joyEl.style.left = input.sx - r.left + 'px'; joyEl.style.top = input.sy - r.top + 'px'; joyEl.classList.add('on'); }
  if (input.joy) { const m = Math.min(l, 44), k = l ? m / l : 0; joyKnob.style.transform = `translate(${dx * k}px,${dy * k}px)`; input.jx = (dx / (l || 1)) * (m / 44); input.jz = (dy / (l || 1)) * (m / 44); }
});
const endPointer = (e) => {
  if (!input.down || e.pointerId !== input.id) return;
  input.down = false;
  if (input.joy) { input.joy = false; input.jx = input.jz = 0; joyEl.classList.remove('on'); joyKnob.style.transform = ''; return; }
  const g = pickGround(e.clientX, e.clientY);
  if (g) { const c = clampPos(g); player.target = c; mark.x = c.x; mark.z = c.z; mark.a = 1; }   // 点到路外面：走到路上离它最近的地方
};
root.addEventListener('pointerup', endPointer); root.addEventListener('pointercancel', endPointer);

const faceOf = (vx, vz) => (Math.abs(vx) > Math.abs(vz) ? (vx > 0 ? 2 : 3) : vz > 0 ? 0 : 1);
const WALK = [1, 0, 2, 0];
function update(dt) {
  let vx = 0, vz = 0; const SPEED = 6.5;
  if (input.joy || input.fake) { vx = input.jx * SPEED; vz = input.jz * SPEED; }
  else if (player.target) {
    const dx = player.target.x - player.x, dz = player.target.z - player.z, l = Math.hypot(dx, dz);
    if (l < 0.25) player.target = null; else { vx = (dx / l) * SPEED; vz = (dz / l) * SPEED; }
  }
  if (vx || vz) {
    if (!FREEZE) {
      const c = clampPos({ x: player.x + vx * dt, z: player.z + vz * dt });
      if (Math.hypot(c.x - player.x, c.z - player.z) < 0.001) { player.target = null; vx = vz = 0; }   // 走到路的边上或尽头，走不动了就停
      player.x = c.x; player.z = c.z;
    }
  }
  if (vx || vz) {
    player.moving = true; player.dir = faceOf(vx, vz); player.anim += dt * 8;
    player.frame = FREEZE ? 1 : WALK[Math.floor(player.anim) % 4];
  } else { player.moving = false; player.frame = 0; }
  if (!player.target && mark.a > 0) mark.a = Math.max(0, mark.a - dt * 3);
}

// ---------- 每一帧 ----------
const v = new THREE.Vector3();
function project(x, y, z) { v.set(x, y, z).project(camera); return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, ok: v.z < 1 && v.z > -1 }; }
const AV = num('av', 1.9);                         // 头像在世界里相当于多大（米）：离得越远越小
const BUB = Q.get('bub');                          // bub=0 不显示气泡，bub=1 一直显示（截图用）；不写 = 站住半秒才冒出来
let still = 0;
const NAME_R = num('nmr', 8.5);                    // 离玩家这么近的人才显示名字，远处只有头像
let focal = 600, near = null;

function frame(dt, time) {
  update(dt);
  stepEnv(FREEZE ? 1 : 1 - Math.exp(-dt * 0.8));
  const k = FREEZE ? 1 : 1 - Math.exp(-dt * 6);
  cam.x += (player.x - cam.x) * k; cam.z += (player.z - cam.z) * k;
  const tx = cam.x * 0.35, ty = 2, tz = cam.z - CAM.ahead;         // 镜头左右只跟一点点：人在路上横着走时，路始终在屏幕中间
  camera.position.set(tx, ty + CAM.dist * Math.sin(PITCH), tz + CAM.dist * Math.cos(PITCH));
  camera.lookAt(tx, ty, tz); camera.updateMatrixWorld();

  setBB(chars, 0, `ch${player.look}_${player.dir}_${player.frame}`, player.x, 1, player.z, 1, 2);
  chars.a.iPos.needsUpdate = chars.a.iUV.needsUpdate = chars.a.iSize.needsUpdate = true;

  const s = env.s, U = sharedU;
  U.uTime.value = time; U.uSunCol.value.fromArray(env.sun); U.uAmbSky.value.fromArray(env.ambS); U.uAmbGnd.value.fromArray(env.ambG); U.uFogCol.value.fromArray(env.fog);
  U.uFogNear.value = s[4]; U.uFogFar.value = s[5]; U.uSnow.value = s[3]; U.uWet.value = s[6]; U.uNight.value = s[8]; U.uWin.value = s[9]; U.uSprLight.value.fromArray(env.spr);
  postU.uTop.value.fromArray(env.top); postU.uMid.value.fromArray(env.mid); postU.uHor.value.fromArray(env.hor);
  postU.uCl.value.fromArray(env.cl); postU.uCm.value.fromArray(env.cm); postU.uCs.value.fromArray(env.cs); postU.uDisc.value.fromArray(env.disc); postU.uGlow.value.fromArray(env.glow); postU.uFlake.value.fromArray(env.flake);
  postU.uCloud.value = s[0]; postU.uRain.value = s[1]; postU.uFall.value = s[2]; postU.uPetal.value = s[14]; postU.uStars.value = s[7]; postU.uGlowK.value = s[10]; postU.uSunVis.value = s[11]; postU.uSunPos.value.set(s[12], s[13]);
  postU.uHorizon.value = 0.5 + 0.5 * Math.tan(PITCH) / Math.tan((camera.fov * Math.PI) / 360);
  // 灯：取离玩家前方最近的 7 盏，夜里玩家自己再提一盏
  const ls = world.lights.map((l) => [l, Math.hypot(l[0] - player.x, l[2] - (player.z - 8))]).sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < 8; i++) { const l = i === 7 ? [player.x, 2.6, player.z + 0.3, 8.5 * Math.max(0, s[8] - 0.5) * 2] : ls[i] ? ls[i][0] : [0, -99, 0, 1]; U.uLights.value[i].set(l[0], l[1], l[2], Math.max(l[3], 0.01)); }
  // 影子：玩家 + 离得最近的 11 个人
  U.uShadows.value[0].set(player.x + 0.25, player.z, 0.62);
  const byD = NPCS.map((n) => [n, Math.hypot(n.x - player.x, n.z - (player.z - 4))]).sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < 12; i++) { const n = byD[i - 1] && byD[i - 1][0]; if (n) U.uShadows.value[i].set(n.x + 0.25, n.z, 0.62); else U.uShadows.value[i].set(0, 0, -1); }
  U.uMark.value.set(mark.x, mark.z, 1.05 + 0.2 * Math.sin(time * 6), mark.a);
  U.uMe.value.set(player.x, player.z, 0, 1);
  const pp = project(player.x, 2.1, player.z);
  v.set(player.x, 1, player.z).applyMatrix4(camera.matrixWorldInverse);
  spriteMat.uniforms.uPlayer.value.set(pp.x / W, 1 - pp.y / H, -v.z, 1); U.uPD.value = -v.z;

  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  renderer.setRenderTarget(null); postU.tScene.value = rt.texture; renderer.render(postScene, postCam);

  // 盖在画面上的网页元素：每个人头顶的头像（离得越远越小，够近才显示名字），走近的那个人多一个气泡
  near = null; let nd = 4.7;
  for (const n of NPCS) { const d = Math.hypot(n.x - player.x, n.z - player.z); if (d < nd) { nd = d; near = n; } }
  const me = camera.matrixWorldInverse.elements, headY = 1.2 + 2.3 * sharedU.uStretch.value;   // 头顶的高度（贴片被拉高了，头像跟着抬高）
  for (const n of NPCS) {
    const depth = -(me[2] * n.x + me[6] * 3.5 + me[10] * n.z + me[14]);
    let show = depth > 4, p = null, size = 0;
    if (show) { p = project(n.x, headY, n.z); size = Math.max(11, Math.min(46, (AV * focal) / depth)); show = p.ok && p.x > -size && p.x < W + size && p.y > 0 && p.y < H + size * 2; }
    if (show !== n.shown) { n.el.style.display = show ? '' : 'none'; n.shown = show; }
    n.size = show ? size : 0; n.sx = p ? p.x : 0; n.sy = p ? p.y : 0; n.depth = depth;
    if (!show) continue;
    const big = n === near ? 1.18 : 1;
    n.el.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-100%) scale(${((size / 40) * big).toFixed(3)})`;
    n.el.style.zIndex = String(9000 - Math.round(depth * 10));
    const cls = (Math.hypot(n.x - player.x, n.z - player.z + 2) < NAME_R ? ' nm-on' : '') + (size < 21 ? ' tiny' : '') + (n === near ? ' near' : '');
    if (cls !== n.cls) { n.el.className = 'npc' + cls; n.cls = cls; }
  }
  // 气泡：走着的时候不冒（不挡人群），站住半秒才冒出离你最近那位的
  still = player.moving ? 0 : still + dt;
  const bubOn = BUB === '0' ? false : BUB === '1' ? true : still > 0.5;
  if (near && near.shown && bubOn) {
    if (bubFor !== near) { bubFor = near; bub.querySelector('.say').textContent = near.say; bub.querySelector('.tags').innerHTML = near.common.map((c) => `<span>${c}</span>`).join(''); }
    const top = near.sy - near.size * 1.18 * 1.55 - 12, half = 102 + 8, cx = Math.min(W - half, Math.max(half, near.sx));
    bub.style.display = 'block'; bub.style.transform = `translate(${cx.toFixed(1)}px,${top.toFixed(1)}px) translate(-50%,-100%)`;
    bub.style.setProperty('--tail', Math.max(-84, Math.min(84, near.sx - cx)).toFixed(1) + 'px');
  } else { bub.style.display = 'none'; bubFor = null; }
  const mp = project(player.x, headY, player.z); meEl.style.transform = `translate(${mp.x.toFixed(1)}px,${mp.y.toFixed(1)}px) translate(-50%,-100%)`;
}

function resize() {
  const r = root.getBoundingClientRect();
  W = Math.max(1, r.width); H = Math.max(1, r.height); LW = Math.ceil(W / PIX); LH = Math.ceil(H / PIX);
  CAM = W > H ? CAMS.land : CAMS.port; PITCH = (CAM.pitch * Math.PI) / 180;
  renderer.setSize(LW, LH, false);
  rt.dispose(); rt = new THREE.WebGLRenderTarget(LW, LH, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
  sharedU.uRes.value.set(LW, LH);
  camera.fov = CAM.fov; camera.aspect = W / H; camera.updateProjectionMatrix();
  focal = H / 2 / Math.tan((CAM.fov * Math.PI) / 360);
  sharedU.uStretch.value = Math.min(1.7, 1 / Math.cos(PITCH));
  root.classList.toggle('land', W > H);
}
window.addEventListener('resize', resize);

// ---------- 左上角：选场景；最下面：样稿专用的调试条（切时间、天气） ----------
menu.innerHTML = SCENES.map((s) => `<div class="it" data-id="${s.id}"><i style="background:${s.dot}"></i><b>${s.name}</b><span>${s.count} 人</span></div>`).join('');
document.getElementById('hud-place').addEventListener('click', () => menu.classList.toggle('on'));
menu.addEventListener('click', (e) => { const it = e.target.closest('.it'); if (!it) return; menu.classList.remove('on'); const S = SCENES.find((s) => s.id === it.dataset.id); if (S !== SC) loadScene(S, false); });
function syncUI() {
  dbg.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === timeKey)); dbg.querySelectorAll('[data-w]').forEach((b) => b.classList.toggle('on', b.dataset.w === weatherKey));
  menu.querySelectorAll('.it').forEach((b) => b.classList.toggle('on', b.dataset.id === SC.id));
  document.getElementById('hud-w').textContent = TIMES[timeKey].name + ' · ' + WEATHER[weatherKey].name;
  document.getElementById('hud-ic').className = 'ic ' + (weatherKey === 'clear' ? (timeKey === 'night' ? 'moon' : 'sun') : weatherKey);
}
dbg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.t) timeKey = b.dataset.t; if (b.dataset.w) weatherKey = b.dataset.w; syncUI(); });
if (Q.get('ui') === '0') dbg.style.display = 'none';
if (Q.get('hint') === '0') document.getElementById('hint').classList.add('off');
if (Q.get('ov') === '0') { ov.style.display = 'none'; document.getElementById('hud').style.display = 'none'; }
if (Q.get('hud') === '0') document.getElementById('hud').style.display = 'none';

resize();
loadScene(SC, Q.has('t') || Q.has('w'));
if (Q.get('menu') === '1') menu.classList.add('on');
if (Q.has('tx')) { player.target = clampPos({ x: num('tx', 0), z: num('tz', 0) }); mark.x = player.target.x; mark.z = player.target.z; mark.a = 1; }
if (Q.get('joy') === '1') { joyEl.style.left = '50%'; joyEl.style.top = '86%'; joyEl.classList.add('on'); joyKnob.style.transform = 'translate(-6px,-40px)'; input.jx = -0.15; input.jz = -0.95; input.fake = true; }

/** 数一数：现在屏幕上有多少个头像、其中多少个「看得清」（直径 ≥ 22 点，并且被前面的头像挡住的不到四成） */
function count() {
  const list = NPCS.filter((n) => n.shown && n.sx > 0 && n.sx < W && n.sy - n.size * 0.9 > 0 && n.sy < H).sort((a, b) => a.depth - b.depth);
  const disc = (n) => ({ x: n.sx, y: n.sy - n.size * (n.cls.includes('nm-on') ? 1.05 : 0.5), r: n.size / 2 });
  let clear = 0, named = 0;
  list.forEach((n, i) => {
    if (n.cls.includes('nm-on')) named++;
    if (n.size < 22) return;
    const c = disc(n); let hit = 0, tot = 0;
    for (let a = 0; a < 12; a++) for (const rr of [0.35, 0.8]) {
      tot++; const px = c.x + Math.cos((a / 12) * 6.283) * c.r * rr, py = c.y + Math.sin((a / 12) * 6.283) * c.r * rr;
      for (let j = 0; j < i; j++) { const o = disc(list[j]); if (Math.hypot(px - o.x, py - o.y) < o.r) { hit++; break; } }
    }
    if (hit / tot < 0.4) clear++;
  });
  return { onScreen: list.length, clear, named, total: NPCS.length, w: Math.round(W), h: Math.round(H) };
}

let last = performance.now(), T0 = num('time', 0), frames = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; T0 += FREEZE ? 0 : dt;
  frame(dt, FREEZE ? num('time', 12.3) : T0);
  frames++; if (frames === 3) document.body.classList.add('ready');
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.__wuyu = { player, get NPCS() { return NPCS; }, atlas, count, get buildMs() { return buildMs; }, get sprites() { return world.sprites.length; }, set(t, w) { if (t) timeKey = t; if (w) weatherKey = w; syncUI(); }, load(id) { loadScene(SCENES.find((s) => s.id === id), false); }, fps: () => frames };
