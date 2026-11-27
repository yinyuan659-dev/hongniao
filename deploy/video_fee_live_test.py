# -*- coding: utf-8 -*-
"""
在服务器上用两个测试号（女 997353、男 711405）实测「视频按分钟收牵豆，只有男方付」（2026-11-27，样稿 design/10-qiandou.html）。
不推音视频流，只走信令：发起、接听、等服务器按分钟扣、挂断，核对扣的牵豆和推给客户端的消息。全程大约 3 分钟。

要先设好 $env:HN_PW（改价、补牵豆要用后台接口，见 deploy/beans.py）。设备号从 deploy/dev_f.json、dev_m.json 读（不入库），不打印 token。
两个测试号要是互相喜欢的（视频要互相喜欢）。

会动的东西，结束时（不管中间有没有出错）都会还原：
  - 两个测试号的「视频见面」开关：测试时打开，测完改回原样；
  - 视频价格：中途会临时改成很贵（测牵豆用完被挂断）和 0（测不收费），测完改回 0.02；
  - 男测试号花掉的牵豆：测完按花掉的数补回去。
留下的痕迹：两个测试号之间多几条通话记录、男测试号明细里多几条「视频见面」和一条补回的充值。

用法：python deploy/video_fee_live_test.py
"""
import asyncio, json, os, sys, time, urllib.request, urllib.error
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import beans  # noqa: E402

BASE = 'https://gphnai.com'
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
fails = 0


def call(path, token=None, body=None, method=None):
    req = urllib.request.Request(BASE + '/api' + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})},
                                 method=method or ('POST' if body is not None else 'GET'))
    try:
        return json.loads(op.open(req, timeout=15).read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8'))
        except Exception:
            return {'code': e.code, 'msg': 'HTTP %d' % e.code}


def ok(cond, label, detail=''):
    global fails
    if not cond:
        fails += 1
    print(('  ✓ ' if cond else '  ✗ ') + label + (('  ← ' + str(detail)) if detail != '' else ''), flush=True)


class User:
    def __init__(self, path):
        dev = json.load(open(path, encoding='utf-8'))
        did = dev.get('deviceId') or dev.get('device_id') or next(v for v in dev.values() if isinstance(v, str) and v.startswith('web_'))
        self.token = (call('/auth/enter', body={'deviceId': did}).get('data') or {})['token']
        me = call('/user/me', self.token)['data']
        self.id, self.sid, self.name, self.allow_video = str(me['id']), me.get('shortId'), me.get('nickname'), bool(me.get('allowVideo'))
        self.frames = []

    def micro(self):
        return int(call('/ai-wallet', self.token)['data']['balanceMicro'])

    def fee(self, peer):
        return call('/call/fee?peerId=' + peer.id, self.token).get('data') or {}

    def invite(self, peer, typ=2):
        return call('/call/invite', self.token, {'calleeId': peer.id, 'type': typ})

    def post(self, path):
        return call(path, self.token, {})

    async def listen(self):
        """一直连着（服务器把它当在线），把收到的通话信令存下来"""
        async with websockets.connect('wss://gphnai.com/ws?token=%s&lang=zh' % self.token, proxy=None, open_timeout=10) as ws:
            async for raw in ws:
                f = json.loads(raw)
                if f.get('op') == 'call':
                    self.frames.append(f)

    async def wait(self, event, call_id, timeout, pred=lambda d: True):
        t0 = time.time()
        while time.time() - t0 < timeout:
            for f in self.frames:
                d = f.get('data') or {}
                if f.get('event') == event and d.get('callId') == call_id and pred(d):
                    return d
            await asyncio.sleep(0.25)
        return None


async def main():
    f, m = User(r'D:\hongniao\deploy\dev_f.json'), User(r'D:\hongniao\deploy\dev_m.json')
    print('女 %s / 男 %s' % (f.sid, m.sid))
    start_micro = m.micro()
    f_start = f.micro()
    print('开始时：男 %.4f 牵豆，女 %.4f 牵豆；视频见面开关 男=%s 女=%s' % (start_micro / 1e6, f_start / 1e6, m.allow_video, f.allow_video))
    listeners = [asyncio.create_task(f.listen()), asyncio.create_task(m.listen())]
    try:
        for u in (f, m):
            call('/user/me', u.token, {'allowVideo': True}, 'PUT')
        await asyncio.sleep(1.5)
        P = 20_000

        print('【1】价格和谁付')
        ok(beans.price().get('videoPerMin') == '0.02', '后台现在的价格是 0.02 牵豆 / 分钟')
        fm, ff = m.fee(f), f.fee(m)
        ok(fm.get('free') is False and fm.get('iPay') is True and fm.get('perMin') == '0.02' and fm.get('enough') is True and fm.get('minutes') == start_micro // P,
           '男方问：要付、0.02 一分钟、够、大约能聊 %d 分钟' % (start_micro // P), fm)
        ok(ff.get('iPay') is False and ff.get('perMin') == '0.02' and 'balance' not in ff, '女方问：不用她付，也看不到男方有多少牵豆', ff)

        print('【2】男打给女：接通扣第 1 分钟，满 1 分钟扣第 2 分钟（要等 1 分钟多）')
        r = m.invite(f)
        cid = (r.get('data') or {}).get('callId')
        ok(bool(cid) and ((r.get('data') or {}).get('fee') or {}).get('iPay') is True, '男方拨出去了，返回里写着由他付', r.get('msg', ''))
        inv = await f.wait('invite', cid, 6)
        ok(inv is not None and (inv.get('fee') or {}).get('iPay') is False, '女方收到来电，来电里写着不用她付', (inv or {}).get('fee'))
        ok(m.micro() == start_micro, '还没接通：没扣')
        t_accept = time.time()
        a = f.post('/call/%s/accept' % cid)
        ok(a.get('code') == 0, '女方接听', a.get('msg', ''))
        tick = await m.wait('fee', cid, 6, lambda d: d.get('minutes') == 1)
        ok(tick is not None and tick.get('used') == '0.02' and tick.get('low') is False, '男方收到：第 1 分钟，已用 0.02', tick)
        ok(m.micro() == start_micro - P, '接通那一刻扣了 0.02')
        ok(len([x for x in f.frames if x.get('event') == 'fee']) == 0, '女方没有收到计费消息')
        tick = await m.wait('fee', cid, 75, lambda d: d.get('minutes') == 2)
        ok(tick is not None and tick.get('used') == '0.04', '满 1 分钟后（%.0f 秒）收到：第 2 分钟，已用 0.04' % (time.time() - t_accept), tick)
        ok(m.micro() == start_micro - 2 * P, '一共扣了 0.04')
        e = m.post('/call/%s/end' % cid)
        ok(e.get('code') == 0, '男方挂断（聊了 %s 秒）' % (e.get('data') or {}).get('durationSec'))
        await asyncio.sleep(8)
        ok(m.micro() == start_micro - 2 * P, '挂断以后没有再扣')
        ok(f.micro() == f_start, '女方的牵豆一直没动')
        led = (call('/ai-wallet/ledger?kind=spend', m.token).get('data') or {}).get('items') or []
        top = led[0] if led else {}
        ok(top.get('title') == '视频见面 · 2 分钟' and top.get('amount') == '0.0400' and top.get('note') == '和' + (f.name or ''), '明细里合成一条：视频见面 · 2 分钟，0.0400，备注「和%s」' % f.name, top)

        print('【3】女打给男：还是男方付，男方的来电里带价格')
        base = m.micro()
        r = f.invite(m)
        cid = (r.get('data') or {}).get('callId')
        ok(bool(cid) and ((r.get('data') or {}).get('fee') or {}).get('iPay') is False, '女方拨出去了，返回里写着不用她付', r.get('msg', ''))
        inv = await m.wait('invite', cid, 6)
        fee = (inv or {}).get('fee') or {}
        ok(fee.get('iPay') is True and fee.get('perMin') == '0.02' and fee.get('enough') is True and bool(fee.get('balance')), '男方的来电里：由你付、0.02 一分钟、现有多少牵豆', fee)
        a = m.post('/call/%s/accept' % cid)
        ok(a.get('code') == 0, '男方接听', a.get('msg', ''))
        tick = await m.wait('fee', cid, 6, lambda d: d.get('minutes') == 1)
        ok(tick is not None and m.micro() == base - P, '接通扣了男方 0.02', tick)
        f.post('/call/%s/end' % cid)
        await asyncio.sleep(1)
        ok(m.micro() == base - P and f.micro() == f_start, '几秒就挂了：按 1 分钟算，不退；女方没花')

        print('【4】牵豆只够 1 分钟：最后 1 分钟有提醒，到点服务器挂断（要等 1 分钟多）')
        base = m.micro()
        dear = (base * 6 // 10) // 100 * 100          # 临时把价格调到「够 1 分钟、不够 2 分钟」
        ok(beans.price(dear / 1e6).get('videoPerMin') is not None, '后台把价格临时改成 %s 牵豆 / 分钟（男方现有 %.4f）' % (dear / 1e6, base / 1e6))
        fm = m.fee(f)
        ok(fm.get('enough') is True and fm.get('minutes') == 1, '男方问：够，只能聊 1 分钟', fm)
        r = m.invite(f)
        cid = (r.get('data') or {}).get('callId')
        await f.wait('invite', cid, 6)
        t_accept = time.time()
        f.post('/call/%s/accept' % cid)
        tick = await m.wait('fee', cid, 6, lambda d: d.get('minutes') == 1)
        ok(tick is not None and tick.get('low') is True, '接通后男方收到：这是最后 1 分钟（low）', tick)
        end_m = await m.wait('end', cid, 80)
        took = time.time() - t_accept
        ok(end_m is not None and end_m.get('code') == 'no_beans' and end_m.get('minutes') == 1 and end_m.get('reason') == '牵豆用完了，通话已结束',
           '%.0f 秒后服务器挂断，男方收到：牵豆用完了，聊了 1 分钟' % took, end_m)
        ok(55 <= took <= 72, '挂断的时间在满 1 分钟前后（%.0f 秒）' % took)
        end_f = await f.wait('end', cid, 5)
        ok(end_f is not None and end_f.get('reason') == '对方牵豆不足，通话已结束' and 'code' not in end_f, '女方收到：对方牵豆不足，通话已结束', end_f)
        ok(m.micro() == base - dear, '只扣了 1 分钟的钱，第 2 分钟没扣')
        r = m.invite(f)
        ok(r.get('reason') == 'no_beans' and not (r.get('data') or {}).get('callId'), '男方再拨：被拒（no_beans）', r.get('msg'))
        r = f.invite(m)
        ok(r.get('reason') == 'peer_no_beans' and r.get('msg') == '对方牵豆不足，暂时不能视频', '女方拨男方：被拒（对方牵豆不足，暂时不能视频）', r.get('msg'))
        r = m.invite(f, 1)
        vcid = (r.get('data') or {}).get('callId')
        ok(bool(vcid) and not (r.get('data') or {}).get('fee'), '语音不受影响：男方牵豆不够也能拨语音，不带收费')
        if vcid:
            m.post('/call/%s/cancel' % vcid)

        print('【5】价格改成 0 = 不收费')
        base = m.micro()
        ok(beans.price(0).get('videoPerMin') == '0.00', '后台把价格改成 0')
        ok(m.fee(f).get('free') is True, '男方问：不收费')
        r = m.invite(f)
        cid = (r.get('data') or {}).get('callId')
        ok(bool(cid) and not (r.get('data') or {}).get('fee'), '牵豆不够的男方现在能拨视频，不带收费', r.get('msg', ''))
        if cid:
            await f.wait('invite', cid, 6)
            f.post('/call/%s/accept' % cid)
            await asyncio.sleep(7)
            m.post('/call/%s/end' % cid)
            ok(m.micro() == base, '接通了 7 秒：没扣')
    finally:
        print('【还原】')
        try:
            ok(beans.price(0.02).get('videoPerMin') == '0.02', '价格改回 0.02')
        except BaseException as e:
            ok(False, '价格改回 0.02', e)
        for u in (f, m):
            call('/user/me', u.token, {'allowVideo': u.allow_video}, 'PUT')
        ok(bool(call('/user/me', m.token)['data'].get('allowVideo')) == m.allow_video and bool(call('/user/me', f.token)['data'].get('allowVideo')) == f.allow_video, '两个测试号的「视频见面」开关改回原样')
        spent = start_micro - m.micro()
        if spent > 0:
            back = -(-spent // 10_000) / 100          # 往上取到分
            try:
                r = beans.add(m.sid, back, '自测后补回')
                ok(not r.get('error'), '男测试号这次花了 %.4f，补回 %.2f，现在 %s' % (spent / 1e6, back, r.get('balance')), r.get('error', ''))
            except BaseException as e:
                ok(False, '补回牵豆', e)
        for t in listeners:
            t.cancel()
    print('有 %d 条不对' % fails if fails else '全部通过')
    sys.exit(1 if fails else 0)


asyncio.run(main())
