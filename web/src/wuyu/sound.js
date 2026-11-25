// 相亲物语 —— 声音：公鸡打鸣。用程序合成出来的（一个振荡器 + 两个滤波器），没有音频文件。

let ctx = null;

/**
 * 手机上的网页要等用户点过屏幕以后才允许出声：第一次点屏幕时调一下这个。
 * 这台手机不支持、或者没点过屏幕，就一直没声音（公鸡照样会抬头做打鸣的动作）。
 */
export function unlockAudio() {
  try {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ctx = new AC(); }
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* 出不了声就不出 */ }
}

/**
 * 在声音设备 c 上，从第 t0 秒起排一声打鸣：「喔、喔、喔——」，两个短音加一个拖长的、先高后落的长音。
 * 返回这一声有多长（秒）。c 也可以是离线的设备（检查用）。
 */
export function scheduleCrow(c, t0, vol = 0.3) {
  const o = c.createOscillator(); o.type = 'sawtooth';
  const lfo = c.createOscillator(); lfo.frequency.value = 6.5;          // 长音后半段的颤
  const lg = c.createGain(); lg.gain.value = 0; lfo.connect(lg); lg.connect(o.frequency);
  const f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 1150; f1.Q.value = 3.5;
  const f2 = c.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 2700; f2.Q.value = 5;
  const g2 = c.createGain(); g2.gain.value = 0.5;
  const g = c.createGain(); g.gain.value = 0;
  o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g2); g2.connect(g); g.connect(c.destination);
  const F = o.frequency, G = g.gain, t = (x) => t0 + x;
  F.setValueAtTime(480, t(0)); F.linearRampToValueAtTime(720, t(0.09)); F.setValueAtTime(720, t(0.15));
  F.setValueAtTime(650, t(0.21)); F.linearRampToValueAtTime(860, t(0.31)); F.setValueAtTime(860, t(0.36));
  F.setValueAtTime(780, t(0.43)); F.linearRampToValueAtTime(1020, t(0.56)); F.linearRampToValueAtTime(980, t(1.0)); F.exponentialRampToValueAtTime(560, t(1.32));
  G.setValueAtTime(0, t(0)); G.linearRampToValueAtTime(vol, t(0.03)); G.setValueAtTime(vol, t(0.13)); G.linearRampToValueAtTime(0, t(0.17));
  G.setValueAtTime(0, t(0.21)); G.linearRampToValueAtTime(vol, t(0.24)); G.setValueAtTime(vol, t(0.34)); G.linearRampToValueAtTime(0, t(0.39));
  G.setValueAtTime(0, t(0.43)); G.linearRampToValueAtTime(vol * 1.15, t(0.48)); G.setValueAtTime(vol * 1.15, t(1.0)); G.linearRampToValueAtTime(0, t(1.35));
  lg.gain.setValueAtTime(0, t(0.55)); lg.gain.linearRampToValueAtTime(22, t(0.8));
  o.start(t(0)); lfo.start(t(0)); o.stop(t(1.4)); lfo.stop(t(1.4));
  return 1.4;
}

export const CROW_LEN = 1.4, CROW_GAP = 0.35;

/** 连着叫两声。出不了声（没点过屏幕、手机不支持）返回 false，调用的人照样可以只做动作 */
export function crowTwice() {
  if (!ctx || ctx.state !== 'running') return false;
  try { const t0 = ctx.currentTime + 0.05; scheduleCrow(ctx, t0); scheduleCrow(ctx, t0 + CROW_LEN + CROW_GAP); return true; } catch { return false; }
}
