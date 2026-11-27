# -*- coding: utf-8 -*-
"""
在服务器上用两个测试号（女 997353、男 711405）实测「聊天放开、视频见面要互相喜欢」（2026-11-27，样稿 design/09-openchat.html）。
设备号从 deploy/dev_f.json、dev_m.json 里读（这两个文件不入库）；不打印 token。

分几段跑，段和段之间要在服务器上改状态（都只动这两个测试号）：
  python deploy/openchat_live_test.py a   先跑 openchat_test_prep.sh（把两人改成「男喜欢了女、女没回应」）。开关开着：
                                          两边都能发消息、语音放行、视频被拒（need_like）
  python deploy/openchat_live_test.py b   先跑 video_like_off.sh。开关关着：没互相喜欢视频也放行
  python deploy/openchat_live_test.py c   先跑 video_like_on.sh。视频又被拒
  python deploy/openchat_live_test.py d   女的点「不再联系」（脚本自己点）：两边都不能发消息、不能打电话
  python deploy/openchat_live_test.py e   先跑 openchat_test_restore.sh（改回互相喜欢）。视频放行、消息照常

「放行」怎么看：通话接口先查「能不能打」，再查对方在不在线。测试时对方不在线，所以放行的结果是「对方不在线，无法接通」
或者「没有打开视频见面」这类后面才查的提示；被这条规则拒绝的结果是 reason=need_like / chat_ended。
"""
import asyncio, json, sys, time, urllib.request, urllib.error
import websockets

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

def enter(path):
    dev = json.load(open(path, encoding='utf-8'))
    did = dev.get('deviceId') or dev.get('device_id') or next(v for v in dev.values() if isinstance(v, str) and v.startswith('web_'))
    tok = (call('/auth/enter', body={'deviceId': did}).get('data') or {})['token']
    me = call('/user/me', tok)['data']
    return tok, str(me['id']), me.get('shortId')

def ok(cond, label, detail=''):
    global fails
    if not cond: fails += 1
    print(('  ✓ ' if cond else '  ✗ ') + label + (('  ← ' + str(detail)) if detail != '' else ''))

async def send(token, target_id, text):
    """发一条文字消息，返回服务器对这一条的回应：{'op': 'ack'} 或 {'op': 'error', 'code': …, 'msg': …}"""
    temp = 't_%d' % int(time.time() * 1000)
    async with websockets.connect('wss://gphnai.com/ws?token=%s&lang=zh' % token, proxy=None, open_timeout=10) as ws:
        await ws.send(json.dumps({'op': 'send', 'tempId': temp, 'convType': 1, 'targetId': target_id, 'msgType': 'text', 'content': text}))
        try:
            while True:
                f = json.loads(await asyncio.wait_for(ws.recv(), 8))
                if f.get('tempId') == temp:
                    return {k: f.get(k) for k in ('op', 'code', 'msg')}
        except asyncio.TimeoutError:
            return {'op': 'timeout'}

def rel(token, peer):
    d = call('/match/relation/' + peer, token).get('data') or {}
    return {k: d.get(k) for k in ('state', 'endedBy', 'canChat', 'chatReason', 'canVideo', 'videoReason', 'legacyUntil')}

def invite(token, peer, typ):
    """发起通话。万一真的拨出去了（对方在线）马上取消。返回 (被这条规则拒绝的原因 或 None, 提示文字)"""
    r = call('/call/invite', token, {'calleeId': peer, 'type': typ})
    cid = (r.get('data') or {}).get('callId')
    if cid:
        call('/call/%s/cancel' % cid, token, {})
        return None, '拨出去了（已取消）'
    return (r.get('reason') if r.get('reason') in ('need_like', 'chat_ended') else None), '%s%s' % (r.get('msg'), (' [reason=%s]' % r['reason']) if r.get('reason') else '')

def main():
    phase = sys.argv[1] if len(sys.argv) > 1 else 'a'
    ft, fid, fsid = enter(r'D:\hongniao\deploy\dev_f.json')
    mt, mid, msid = enter(r'D:\hongniao\deploy\dev_m.json')
    print('女 %s / 男 %s  阶段 %s' % (fsid, msid, phase))
    rm, rf = rel(mt, fid), rel(ft, mid)
    print('  男看女:', rm); print('  女看男:', rf)
    stamp = time.strftime('%H:%M:%S')

    if phase in ('a', 'c'):
        ok(rm['state'] == 'liked' and rf['state'] == 'likedMe', '关系：男喜欢了女、女还没回应')
        ok(rm['canChat'] is True and rm['chatReason'] == 'open' and rf['canChat'] is True, '关系里写着两边都能发消息')
        ok(rm['canVideo'] is False and rm['videoReason'] == 'need_like' and rf['canVideo'] is False, '关系里写着现在不能视频（没互相喜欢）')
        if phase == 'a':
            r = asyncio.run(send(mt, fid, '【自测 %s】没互相喜欢，男先发' % stamp)); ok(r['op'] == 'ack', '男给女发消息：发出去了', r)
            r = asyncio.run(send(ft, mid, '【自测 %s】没互相喜欢，女先发' % stamp)); ok(r['op'] == 'ack', '女给男发消息：发出去了', r)
            why, msg = invite(mt, fid, 1); ok(why is None, '男给女打语音：放行', msg)
            why, msg = invite(ft, mid, 1); ok(why is None, '女给男打语音：放行', msg)
        why, msg = invite(mt, fid, 2); ok(why == 'need_like', '男给女打视频：被拒（need_like）', msg)
        why, msg = invite(ft, mid, 2); ok(why == 'need_like', '女给男打视频：被拒（need_like）', msg)
    elif phase == 'b':
        ok(rm['state'] == 'liked' and rm['canVideo'] is True and rm['videoReason'] == 'ok' and rf['canVideo'] is True, '开关关着：关系里写着没互相喜欢也能视频')
        why, msg = invite(mt, fid, 2); ok(why is None, '男给女打视频：放行', msg)
        why, msg = invite(ft, mid, 2); ok(why is None, '女给男打视频：放行', msg)
    elif phase == 'd':
        r = call('/match/end/' + mid, ft, {}); ok((r.get('data') or {}).get('state') == 'ended', '女对男点「不合适，不再联系」（两人没互相喜欢，以前这种情况点不了）', r.get('msg', ''))
        rm, rf = rel(mt, fid), rel(ft, mid)
        ok(rm['state'] == 'ended' and rm['endedBy'] == 'peer' and rm['canChat'] is False and rm['canVideo'] is False, '男这边：对方已结束聊天', rm)
        ok(rf['endedBy'] == 'me' and rf['canChat'] is False, '女这边：你已选择不再联系')
        r = asyncio.run(send(mt, fid, '【自测 %s】这条应该发不出去' % stamp)); ok(r['op'] == 'error' and r['code'] == 'chat_ended', '男再给女发消息：被拒（chat_ended）', r)
        r = asyncio.run(send(ft, mid, '【自测 %s】这条应该发不出去' % stamp)); ok(r['op'] == 'error' and r['code'] == 'chat_ended', '女再给男发消息：被拒（chat_ended）', r)
        why, msg = invite(mt, fid, 1); ok(why == 'chat_ended', '男给女打语音：被拒（chat_ended）', msg)
        why, msg = invite(mt, fid, 2); ok(why == 'chat_ended', '男给女打视频：被拒（chat_ended）', msg)
    elif phase == 'e':
        ok(rm['state'] == 'mutual' and rf['state'] == 'mutual' and rm['canChat'] is True and rm['canVideo'] is True and rm['videoReason'] == 'ok', '关系：互相喜欢，能发消息、能视频')
        r = asyncio.run(send(mt, fid, '【自测 %s】互相喜欢，照常能发' % stamp)); ok(r['op'] == 'ack', '男给女发消息：发出去了', r)
        why, msg = invite(mt, fid, 2); ok(why is None, '男给女打视频：放行', msg)
        why, msg = invite(mt, fid, 1); ok(why is None, '男给女打语音：放行', msg)
    print('有 %d 条不对' % fails if fails else '这一段全部通过')
    sys.exit(1 if fails else 0)

main()
