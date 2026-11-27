# -*- coding: utf-8 -*-
# 真实走一遍通话的媒体链路：浏览器用假摄像头 / 假麦克风，经 https://gphnai.com/rtc/v1/whip/ 推一路流，再经 /whep/ 拉回来，
# 看信令状态码、SRS 回的候选地址、连接状态、拉流那边有没有真的收到音视频数据。
# 另外用女测试号问一下后端现在下发的通话地址。
#
# 用法（本机，要装 playwright，用系统的 Edge）：python deploy/rtc_selftest.py
# 看结果：whip / whep 的 status 是 201 = 信令通；pubConnected / subConnected 是 true、received 里 bytes 大于 0 = 音视频真的通了。
# 信令通、连接一直 connecting、服务器 8000/udp 收不到包 = 阿里云安全组没放行 UDP 8000（2026-11-27 就是这样：规则加成了 TCP）。
import json, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'https://gphnai.com'
STREAM = 'selftest_%d' % __import__('time').time()
JS = r'''
async ({ base, stream }) => {
  const out = { stream };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function exchange(kind, pc) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch(`${base}/rtc/v1/${kind}/?app=live&stream=${stream}`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp });
    const sdp = await r.text();
    out[kind] = { status: r.status, contentType: r.headers.get('content-type'), candidates: (sdp.match(/a=candidate:.*/g) || []).map((c) => c.split(' ').slice(2, 8).join(' ')) };
    if (r.status >= 300) { out[kind].body = sdp.slice(0, 120); return false; }
    await pc.setRemoteDescription({ type: 'answer', sdp });
    return true;
  }
  async function waitConnected(pc, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pc.connectionState === 'connected') return true; if (pc.connectionState === 'failed') return false; await sleep(200); }
    return false;
  }
  const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 480 } });
  const pub = new RTCPeerConnection();
  media.getTracks().forEach((t) => pub.addTransceiver(t, { direction: 'sendonly' }));
  if (!(await exchange('whip', pub))) return out;
  out.pubConnected = await waitConnected(pub, 12000);
  out.pubState = pub.connectionState;
  await sleep(1500);
  const sub = new RTCPeerConnection();
  sub.addTransceiver('audio', { direction: 'recvonly' });
  sub.addTransceiver('video', { direction: 'recvonly' });
  if (!(await exchange('whep', sub))) return out;
  out.subConnected = await waitConnected(sub, 8000);
  out.subState = sub.connectionState;
  await sleep(9000);
  const stat = async (pc, type) => { const o = {}; (await pc.getStats()).forEach((s) => { if (s.type === type) o[s.kind] = { bytes: s.bytesSent ?? s.bytesReceived, packets: s.packetsSent ?? s.packetsReceived, frames: s.framesEncoded ?? s.framesDecoded }; }); return o; };
  out.sent = await stat(pub, 'outbound-rtp');
  out.received = await stat(sub, 'inbound-rtp');
  let pair = null; (await sub.getStats()).forEach((s) => { if (s.type === 'candidate-pair' && s.nominated) pair = s; });
  if (pair) (await sub.getStats()).forEach((s) => { if (s.id === pair.remoteCandidateId) out.remote = `${s.protocol} ${s.address}:${s.port}`; });
  pub.close(); sub.close(); media.getTracks().forEach((t) => t.stop());
  return out;
}
'''
with sync_playwright() as p:
    b = p.chromium.launch(channel='msedge', headless=True, args=['--no-proxy-server', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
    ctx = b.new_context(permissions=['camera', 'microphone'])
    pg = ctx.new_page()
    pg.goto('https://gphnai.com/privacy.html', wait_until='domcontentloaded')   # 同一个网站下的静态页，借它的环境发请求
    try:
        r = pg.evaluate(JS, {'base': BASE, 'stream': STREAM})
        print(json.dumps(r, ensure_ascii=False, indent=1))
    except Exception as e:
        print('FAIL', type(e).__name__, str(e)[:300])
    b.close()

# 后端现在下发的通话地址（女测试号）
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path, token=None, body=None):
    req = urllib.request.Request('https://gphnai.com/api' + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    try:
        return json.loads(op.open(req, timeout=15).read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {'http': e.code}
dev = json.load(open(r'D:\hongniao\deploy\dev_f.json', encoding='utf-8'))
did = dev.get('deviceId') or dev.get('device_id') or next(v for v in dev.values() if isinstance(v, str) and v.startswith('web_'))
tok = (call('/auth/enter', body={'deviceId': did}).get('data') or {}).get('token')
cfg = call('/call/config', tok).get('data') or {}
print('GET /call/config ->', {k: cfg.get(k) for k in ('srsServer', 'whipUrl', 'whepUrl', 'width', 'height', 'fps', 'bitrate')})
