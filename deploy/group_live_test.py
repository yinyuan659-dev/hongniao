# -*- coding: utf-8 -*-
"""
在服务器上用两个测试号（女 997353、男 711405）实测群聊后端（2026-11-27，样稿 design/12-group.html）。
设备号从 deploy/dev_f.json、dev_m.json 里读（这两个文件不入库）；不打印 token。后台接口通过 SSH 在服务器上调（deploy/beans.py 里的 admin）。
先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'。

  python deploy/group_live_test.py           跑一遍
  python deploy/group_live_test.py clean     只把上一次没跑完留下的测试群删掉
  python deploy/group_live_test.py restart   后端重启以后到期定时器还在不在（会重启后端容器，停几秒）

会建 4 个测试群（kind=test，男号是群主），测完全部彻底删掉，不留在服务器上。只动这两个测试号。
测的东西：建群 / 进群的推送、消息列表、收发、未读、回复、表情、置顶、转发、改群名和公告、免打扰、权限、举报、搜索、
退群（之后看不到新消息、发不出去）、重新进群、移出（进不回来）、从列表里删掉、到期自动解散、平台关闭和恢复、群主解散、
不是成员的人进不去、单聊没被改坏。
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


def enter(path):
    dev = json.load(open(path, encoding='utf-8'))
    did = dev.get('deviceId') or dev.get('device_id') or next(v for v in dev.values() if isinstance(v, str) and v.startswith('web_'))
    tok = (call('/auth/enter', body={'deviceId': did}).get('data') or {})['token']
    me = call('/user/me', tok)['data']
    return tok, str(me['id']), str(me.get('shortId')), me.get('nickname')


def ok(cond, label, detail=''):
    global fails
    if not cond:
        fails += 1
    print(('  ✓ ' if cond else '  ✗ ') + label + (('  ← ' + str(detail)[:300]) if (detail != '' and not cond) else ''))
    return cond


ADMIN_LOOP = r'''
import json, re, sys, urllib.request, urllib.error
env = open('/opt/hongniang/.env', encoding='utf-8').read()
pw = re.search(r'(?m)^ADMIN_INIT_PASSWORD=(.*)$', env).group(1).strip()
def call(method, path, body=None, token=None):
    req = urllib.request.Request('https://gphnai.com/api/admin' + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})}, method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8', 'replace'))
        except Exception:
            return {'code': e.code, 'msg': 'HTTP %d' % e.code}
r = call('POST', '/login', {'username': 'admin', 'password': pw})
tok = (r.get('data') or {}).get('token')
print('READY' if tok else 'NOLOGIN ' + str(r.get('msg')), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    method, path, body = json.loads(line)
    r = call(method, path, body, tok)
    print('RESULT ' + json.dumps(r.get('data') if r.get('code') == 0 else {'error': r.get('msg') or r}, ensure_ascii=False), flush=True)
'''


class AdminSession:
    """
    一条 SSH 连接，服务器上跑一小段脚本：只登录后台一次（后台登录 5 分钟只让登 10 次），然后一行一行收指令调后台接口。
    管理员密码、登录令牌都只在服务器上那个进程里，不打印、不传回本机。
    """

    def __init__(self):
        self.c = beans.remote.connect()
        self.stdin, self.stdout, _ = self.c.exec_command("python3 -u /dev/fd/3 3<<'HNPYEOF'\n" + ADMIN_LOOP + "\nHNPYEOF\n", timeout=120)
        first = self.stdout.readline().strip()
        if first != 'READY':
            self.close()
            raise SystemExit('后台登录失败：' + first)

    def call(self, method, path, body=None):
        self.stdin.write(json.dumps([method, path, body]) + '\n')
        self.stdin.flush()
        while True:
            line = self.stdout.readline()
            if not line:
                return {'error': '服务器上的脚本断了'}
            if line.startswith('RESULT '):
                return json.loads(line[7:])

    def close(self):
        try:
            self.stdin.channel.shutdown_write()
        except Exception:
            pass
        self.c.close()


ADMIN = None


async def admin(method, path, body=None):
    """调一个后台接口（走 SSH，放到线程里，不卡住 WebSocket）。失败返回 {'error': …}"""
    return await asyncio.to_thread(ADMIN.call, method, path, body)


class Conn:
    """一条一直开着的 WebSocket：后台收帧，测试里按条件等某一帧"""

    def __init__(self, token):
        self.token, self.frames, self.ws, self.task, self.n = token, [], None, None, 0

    async def open(self):
        self.ws = await websockets.connect('wss://gphnai.com/ws?token=%s&lang=zh' % self.token, proxy=None, open_timeout=10)
        self.task = asyncio.create_task(self._read())

    async def _read(self):
        try:
            async for raw in self.ws:
                self.frames.append(json.loads(raw))
        except Exception:
            pass

    def mark(self):
        """记下现在收到第几帧；之后 wait 只看这之后来的"""
        self.n = len(self.frames)

    async def wait(self, pred, timeout=8):
        end = time.time() + timeout
        while time.time() < end:
            for f in self.frames[self.n:]:
                if pred(f):
                    return f
            await asyncio.sleep(0.1)
        return None

    async def send(self, conv_type, target, text, reply_to=None):
        temp = 't_%d_%d' % (int(time.time() * 1000), len(self.frames))
        frame = {'op': 'send', 'tempId': temp, 'convType': conv_type, 'targetId': str(target), 'msgType': 'text', 'content': text}
        if reply_to:
            frame['replyToId'] = str(reply_to)
        self.mark()
        await self.ws.send(json.dumps(frame))
        f = await self.wait(lambda x: x.get('tempId') == temp)
        return f or {'op': 'timeout'}

    async def close(self):
        if self.task:
            self.task.cancel()
        if self.ws:
            await self.ws.close()


def conv_of(token, cid):
    rows = call('/im/conversations', token).get('data') or []
    return next((r for r in rows if str(r.get('id')) == str(cid)), None)


def group_event(event, gid):
    return lambda f: f.get('op') == 'group' and (f.get('data') or {}).get('event') == event and str((f.get('data') or {}).get('groupId')) == str(gid)


def sys_msg(gid, k):
    def pred(f):
        d = f.get('data') or {}
        if f.get('op') != 'msg' or d.get('type') != 'sys' or str(d.get('groupId')) != str(gid):
            return False
        try:
            return json.loads(d.get('content') or '{}').get('k') == k
        except Exception:
            return False
    return pred


async def main():
    global ADMIN
    ADMIN = AdminSession()
    ft, fid, fsid, fname = enter(r'D:\hongniao\deploy\dev_f.json')
    mt, mid, msid, mname = enter(r'D:\hongniao\deploy\dev_m.json')
    print('女 %s / 男 %s（男是群主）' % (fsid, msid))
    stamp = time.strftime('%H%M%S')
    if len(sys.argv) > 1 and sys.argv[1] == 'clean':
        # 上一次没跑完留下的测试群：全部删掉
        lst = await admin('GET', '/groups?cat=all&size=100')
        for g in lst.get('list') or []:
            if g.get('kind') == 'test':
                r = await admin('POST', '/groups/%s/delete-test' % g['id'])
                ok(not r.get('error'), '删掉留下的测试群 %s %s' % (g['id'], g['name']), r)
        lst = await admin('GET', '/groups?cat=all')
        ok(lst.get('total') == 0, '后台群列表是空的', lst)
        ADMIN.close()
        return
    F, M = Conn(ft), Conn(mt)
    await F.open(); await M.open()
    made = []
    try:
        before_f = [r for r in (call('/im/conversations', ft).get('data') or []) if r.get('type') == 2]
        before_m = [r for r in (call('/im/conversations', mt).get('data') or []) if r.get('type') == 2]
        ok(not before_f and not before_m, '开始前两个号的消息列表里都没有群', (before_f, before_m))
        singles_before = len([r for r in (call('/im/conversations', ft).get('data') or []) if r.get('type') == 1])

        print('【1 建群、进群】')
        F.mark(); M.mark()
        g = await admin('POST', '/groups/test', {'owner': msid, 'name': '自测群一 ' + stamp, 'members': [fsid]})
        ok(not g.get('error') and g.get('id'), '后台建测试群，男是群主，女进群', g)
        gid, cid = str(g['id']), str(g['conversationId'])
        made.append(gid)
        ok(await M.wait(group_event('create', gid)) is not None, '男收到推送：群建好了')
        f = await F.wait(group_event('join', gid))
        ok(f is not None and f['data']['group']['memberCount'] == 2 and str(f['data']['userId']) == fid, '女收到推送：进群了，推送里带着群信息（2 人）', f)
        ok(await M.wait(group_event('join', gid)) is not None, '男收到推送：有人进群')
        ok(await M.wait(sys_msg(gid, 'join')) is not None, '男收到那行灰色小字「加入了群聊」')
        rf, rm = conv_of(ft, cid), conv_of(mt, cid)
        ok(rf and rf['type'] == 2 and rf['group']['state'] == 'ok' and rf['group']['memberCount'] == 2 and rf['group']['role'] == 'member', '女的消息列表里马上有这个群（没人说话也有）', rf)
        ok(rm and rm['group']['role'] == 'owner' and rm['group']['kind'] == 'test', '男的消息列表里也有，身份是群主', rm)
        ok(rf and rf['lastMsg'] and rf['lastMsg']['type'] == 'sys' and '加入了群聊' in rf['lastMsg']['content'] and rf['unread'] == 0, '预览是「加入了群聊」，灰色小字不算未读', rf and rf.get('lastMsg'))
        v = call('/im/group/' + gid, ft).get('data') or {}
        ok(v.get('state') == 'ok' and v.get('role') == 'member' and len(v.get('members') or []) == 2 and v['members'][0]['role'] == 'owner' and str(v['members'][0]['id']) == mid, '群资料：2 个成员，群主排第一个', v)

        print('【2 收发、未读、回复】')
        M.mark()
        a = await F.send(2, gid, '【自测】女在群里说话 ' + stamp)
        ok(a.get('op') == 'ack' and str(a.get('conversationId')) == cid, '女在群里发消息：发出去了', a)
        mf = await M.wait(lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('id') == a.get('msgId'))
        ok(mf is not None and mf['data']['convType'] == 2 and str(mf['data']['groupId']) == gid and mf['data']['senderNickname'] == fname and mf['data']['receiverId'] is None, '男实时收到，带群 id、发的人的昵称', mf)
        rm, rf = conv_of(mt, cid), conv_of(ft, cid)
        ok(rm['unread'] == 1 and rf['unread'] == 0, '男未读 1，女自己发的不算未读', (rm['unread'], rf['unread']))
        ok(rm['lastMsg']['senderNickname'] == fname and '女在群里说话' in rm['lastMsg']['content'], '列表预览带着是谁说的', rm['lastMsg'])
        await M.ws.send(json.dumps({'op': 'read', 'conversationId': cid, 'msgId': a['msgId']}))
        await asyncio.sleep(1)
        ok(conv_of(mt, cid)['unread'] == 0, '男读了以后未读变 0')
        F.mark()
        b = await M.send(2, gid, '【自测】群主回复 ' + stamp, reply_to=a['msgId'])
        ok(b.get('op') == 'ack', '群主回复这条消息：发出去了', b)
        ff = await F.wait(lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('id') == b.get('msgId'))
        ok(ff is not None and (ff['data'].get('replyTo') or {}).get('id') == a['msgId'], '女收到，带着引用的那条', ff)
        ms = call('/im/messages?conversationId=%s' % cid, ft).get('data') or []
        ok([m['type'] for m in ms][-2:] == ['text', 'text'] and any(m['type'] == 'sys' for m in ms), '聊天记录里有灰色小字和两条消息，顺序对', [m['type'] for m in ms])

        print('【3 表情、置顶、转发、搜索】')
        M.mark()
        r = call('/im/messages/%s/react' % b['msgId'], ft, {'emoji': '❤️'})
        ok(r.get('code') == 0 and await M.wait(lambda x: x.get('op') == 'msg_reactions' and x['data']['msgId'] == b['msgId']) is not None, '女给群主的消息点表情，群主实时收到', r)
        r = call('/im/messages/%s/pin' % a['msgId'], ft, {'pin': True})
        ok(r.get('code') == 403, '普通成员置顶：被拒', r)
        F.mark()
        r = call('/im/messages/%s/pin' % a['msgId'], mt, {'pin': True})
        ok(r.get('code') == 0 and await F.wait(lambda x: x.get('op') == 'msg_pin' and x['data']['msgId'] == a['msgId']) is not None, '群主置顶，女实时收到', r)
        ok(len(call('/im/conversations/%s/pins' % cid, ft).get('data') or []) == 1, '置顶列表里有 1 条')
        F.mark()
        r = call('/im/messages/forward', mt, {'fromConversationId': cid, 'ids': [a['msgId']], 'targets': [{'convType': 2, 'targetId': gid}]})
        ok(r.get('code') == 0 and (r['data']['results'][0] or {}).get('ok') is True, '把一条消息转发到群里', r)
        ok(await F.wait(lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('fwdFrom') == fname) is not None, '女收到转发来的那条（带原来是谁发的）')
        r = call('/im/messages/forward', mt, {'fromConversationId': cid, 'ids': [ms[0]['id']], 'targets': [{'convType': 2, 'targetId': gid}]})
        ok(r.get('code') == 400, '灰色小字不能转发', r)
        r = call('/im/search?q=' + urllib.request.quote('群主回复 ' + stamp), ft).get('data') or {}
        hit = next((m for m in r.get('messages') or [] if m.get('id') == b['msgId']), None)
        ok(hit is not None and hit['convType'] == 2 and str(hit['targetId']) == gid and '自测群一' in hit['title'], '搜索能搜到群里的消息，标题是群名', r.get('messages'))

        print('【4 群主改群名和公告、免打扰、权限】')
        r = call('/im/group/%s/update' % gid, ft, {'name': '乱改'})
        ok(r.get('code') == 403, '普通成员改群名：被拒', r)
        F.mark()
        r = call('/im/group/%s/update' % gid, mt, {'name': '自测群一改名 ' + stamp, 'notice': '早上 7 点集合'})
        ok(r.get('code') == 0 and r['data']['name'].startswith('自测群一改名') and r['data']['notice'] == '早上 7 点集合', '群主改群名、写公告', r)
        f = await F.wait(lambda x: group_event('info', gid)(x) and x['data']['group']['notice'] == '早上 7 点集合')
        ok(f is not None and f['data']['group']['name'].startswith('自测群一改名'), '女实时收到新的群名和公告（推送里直接带着）', f)
        ok(await F.wait(sys_msg(gid, 'rename'), 3) is not None, '群里出一行「群主把群名改成了…」')
        r = call('/im/group/%s/update' % gid, mt, {'name': '   '})
        ok(r.get('code') == 400, '群名不能是空的', r)
        r = call('/im/group/%s/mute' % gid, ft, {'muted': True})
        ok(r.get('code') == 0 and conv_of(ft, cid)['muted'] is True and conv_of(mt, cid)['muted'] is False, '女打开免打扰，只影响自己', r)
        call('/im/group/%s/mute' % gid, ft, {'muted': False})
        ok(conv_of(ft, cid)['muted'] is False, '关掉免打扰')
        ok(call('/im/group/%s/kick' % gid, ft, {'userId': mid}).get('code') == 403, '普通成员移出别人：被拒')
        ok(call('/im/group/%s/dissolve' % gid, ft, {}).get('code') == 403, '普通成员解散：被拒')
        ok(call('/im/group/%s/leave' % gid, mt, {}).get('code') == 400, '群主退群：被拒')
        ok(call('/im/group/%s/kick' % gid, mt, {'userId': mid}).get('code') == 400, '群主移出自己：被拒')
        ok(call('/im/conversations/%s/clear' % cid, ft, {}).get('code') == 403, '群聊不能清空聊天记录')
        ok(call('/im/group/%s/hide' % gid, ft, {}).get('code') == 400, '还在群里的群不能从列表里删')

        print('【5 举报】')
        r = call('/im/messages/%s/report' % b['msgId'], ft, {'reason': '线下不安全'})
        ok(r.get('code') == 0, '举报群里的一条消息', r)
        ok(call('/im/messages/%s/report' % ms[0]['id'], ft, {'reason': '其他'}).get('code') == 400, '灰色小字不能举报')
        r = call('/im/group/%s/report' % gid, ft, {'reason': '诈骗'})
        ok(r.get('code') == 0 and not r['data'].get('duplicated'), '举报这个群', r)
        ok((call('/im/group/%s/report' % gid, ft, {'reason': '诈骗'}).get('data') or {}).get('duplicated') is True, '重复举报不会多记一条')
        ok(call('/im/group/%s/report' % gid, ft, {'reason': ''}).get('code') == 400, '不选原因不能举报')
        reps = await admin('GET', '/reports?status=0')
        grep = next((x for x in reps if x.get('targetType') == 'group' and str(x.get('targetId')) == gid), None) if isinstance(reps, list) else None
        mrep = next((x for x in reps if x.get('targetType') == 'message' and str(x.get('targetId')) == b['msgId']), None) if isinstance(reps, list) else None
        ok(grep is not None and grep['group']['name'].startswith('自测群一') and grep['reason'] == '诈骗', '后台举报列表里有这条群举报，带群名', reps if not isinstance(reps, list) else grep)
        ok(mrep is not None and mrep['message']['convType'] == 2 and '群主回复' in mrep['message']['content'], '后台能看到被举报的那条群消息的内容', mrep)
        lst = await admin('GET', '/groups?q=' + gid)
        row = next((x for x in (lst.get('list') or []) if str(x['id']) == gid), None)
        ok(row is not None and row['members'] == 2 and row['pendingReports'] == 1 and row['owner']['shortId'] == msid, '后台群列表：2 人、1 条待处理举报、群主对', lst)
        am = await admin('GET', '/groups/%s/messages' % gid)
        ok(isinstance(am, list) and any('群主回复' in (x.get('content') or '') for x in am), '后台能看这个群的聊天记录', am)

        print('【6 退群】')
        M.mark(); F.mark()
        r = call('/im/group/%s/leave' % gid, ft, {})
        ok(r.get('code') == 0, '女退出群聊', r)
        f = await M.wait(group_event('leave', gid))
        ok(f is not None and f['data']['group']['memberCount'] == 1 and str(f['data']['userId']) == fid, '群主实时收到：有人退了，剩 1 人', f)
        ok(await F.wait(group_event('leave', gid)) is not None, '女自己的其他设备也会收到')
        rf = conv_of(ft, cid)
        ok(rf and rf['group']['state'] == 'left' and rf['unread'] == 0 and '退出了群聊' in rf['lastMsg']['content'], '女的列表里这个群还在，状态是「已不在群里」', rf)
        e = await F.send(2, gid, '【自测】退群后发，应该发不出去')
        ok(e.get('op') == 'error' and e.get('code') == 'group_left', '退群后发消息：被拒（group_left）', e)
        c = await M.send(2, gid, '【自测】女退群以后群主说的话 ' + stamp)
        ok(c.get('op') == 'ack', '群主接着发了一条')
        ms2 = call('/im/messages?conversationId=%s' % cid, ft).get('data') or []
        ok(ms2 and all(m['id'] != c['msgId'] for m in ms2) and any(m['id'] == b['msgId'] for m in ms2), '女还能看退群之前的记录，看不到退群之后的', [m['id'] for m in ms2][-3:])
        ok('退出了群聊' in conv_of(ft, cid)['lastMsg']['content'], '女的列表预览停在退群那一刻')
        v = call('/im/group/' + gid, ft).get('data') or {}
        ok(v.get('state') == 'left' and v.get('members') == [], '退群后看群资料：看不到成员名单', v)
        ok(call('/im/messages/%s/react' % b['msgId'], ft, {'emoji': '👍'}).get('code') == 403, '退群后不能点表情')
        ok((call('/im/conversations/%s/pins' % cid, ft).get('data')) == [], '退群后看不到置顶')

        print('【7 重新进群、移出】')
        F.mark()
        r = await admin('POST', '/groups/%s/add' % gid, {'who': fsid})
        ok(not r.get('error'), '女重新进群（相当于再点一次约单）', r)
        rf = conv_of(ft, cid)
        ok(rf['group']['state'] == 'ok' and rf['unread'] == 0, '状态变回正常，不在群里那段时间的消息不算未读', rf)
        a2 = await F.send(2, gid, '【自测】回来了')
        ok(a2.get('op') == 'ack', '又能发消息了', a2)
        F.mark(); M.mark()
        r = call('/im/group/%s/kick' % gid, mt, {'userId': fid})
        ok(r.get('code') == 0, '群主把女移出', r)
        f = await F.wait(group_event('kick', gid))
        ok(f is not None and str(f['data']['userId']) == fid, '女实时收到：被移出了', f)
        ok(await F.wait(sys_msg(gid, 'kick'), 3) is not None, '被移出的人也看得到那行「被群主移出了群聊」')
        ok(conv_of(ft, cid)['group']['state'] == 'kicked', '女的列表里状态是「被移出」')
        e = await F.send(2, gid, '【自测】被移出后发')
        ok(e.get('op') == 'error' and e.get('code') == 'group_left', '被移出后发消息：被拒（group_left）', e)
        r = await admin('POST', '/groups/%s/add' % gid, {'who': fsid})
        ok('移出' in str(r.get('error') or ''), '被移出的人不能再进这个群', r)
        ok(call('/im/group/%s/kick' % gid, mt, {'userId': fid}).get('code') == 404, '已经不在群里的人不能再移一次')
        r = call('/im/group/%s/hide' % gid, ft, {})
        ok(r.get('code') == 0 and conv_of(ft, cid) is None and conv_of(mt, cid) is not None, '女把这个群从自己的列表里删掉，群主那边还在', r)

        print('【8 到期自动解散（到点触发：定 4 秒后到期）】')
        F.mark(); M.mark()
        t0 = time.time()
        g2 = await admin('POST', '/groups/test', {'owner': msid, 'name': '自测群二 ' + stamp, 'members': [fsid], 'expireInSec': 4})
        gid2, cid2 = str(g2['id']), str(g2['conversationId'])
        made.append(gid2)
        ok(conv_of(ft, cid2)['group']['state'] == 'ok', '到期之前是正常的')
        f = await F.wait(group_event('dissolved', gid2), 20)
        took = time.time() - t0
        ok(f is not None and f['data']['group']['status'] == 1, '到期后女实时收到：群解散了', f)
        ok(f is not None and 3.0 <= took <= 7.5, '是到点触发的：从建群到收到解散推送用了 %.1f 秒（定的是 4 秒）' % took, took)
        await asyncio.sleep(1.5)
        n_dis = len([m for m in (call('/im/messages?conversationId=%s' % cid2, ft).get('data') or []) if m['type'] == 'sys' and '"dissolve"' in m['content']])
        ok(n_dis == 1, '群里只出了一行「自动解散」，没有重复', n_dis)
        ok(await M.wait(group_event('dissolved', gid2), 5) is not None, '群主也收到')
        rf = conv_of(ft, cid2)
        ok(rf and rf['group']['state'] == 'dissolved' and '自动解散' in rf['lastMsg']['content'], '列表里这个群还在，状态是「已解散」', rf)
        e = await F.send(2, gid2, '【自测】解散后发')
        ok(e.get('op') == 'error' and e.get('code') == 'group_dissolved', '解散后发消息：被拒（group_dissolved）', e)
        ok(len(call('/im/messages?conversationId=%s' % cid2, ft).get('data') or []) >= 2, '解散后之前的记录还能看')
        r = await admin('POST', '/groups/%s/add' % gid2, {'who': fsid})
        ok('解散' in str(r.get('error') or ''), '解散的群不能再进人', r)
        ok(call('/im/group/%s/hide' % gid2, mt, {}).get('code') == 0 and conv_of(mt, cid2) is None, '群主把解散的群从列表里删掉')

        print('【9 平台关闭 / 恢复、群主解散】')
        g3 = await admin('POST', '/groups/test', {'owner': msid, 'name': '自测群三 ' + stamp, 'members': [fsid]})
        gid3, cid3 = str(g3['id']), str(g3['conversationId'])
        made.append(gid3)
        r = await admin('POST', '/groups/%s/add' % gid3, {'who': fsid})
        ok(not r.get('error') and conv_of(ft, cid3)['group']['memberCount'] == 2, '已经在群里的人再「进群」不报错，人数不变', r)
        F.mark()
        r = await admin('POST', '/groups/%s/closed' % gid3, {'closed': True})
        ok(r.get('status') == 2 and await F.wait(group_event('closed', gid3)) is not None, '后台关闭这个群，女实时收到', r)
        e = await F.send(2, gid3, '【自测】关闭后发')
        ok(e.get('op') == 'error' and e.get('code') == 'group_closed', '关闭后发消息：被拒（group_closed）', e)
        ok(conv_of(ft, cid3)['group']['state'] == 'closed', '列表里状态是「被平台关闭」')
        F.mark()
        r = await admin('POST', '/groups/%s/closed' % gid3, {'closed': False})
        ok(r.get('status') == 0 and await F.wait(group_event('reopen', gid3)) is not None, '后台恢复，女实时收到', r)
        ok((await F.send(2, gid3, '【自测】恢复后发')).get('op') == 'ack', '恢复后又能发了')
        r = await admin('POST', '/groups/%s/remove' % gid3, {'userId': mid})
        ok('群主' in str(r.get('error') or ''), '后台不能移出群主', r)
        F.mark()
        r = await admin('POST', '/groups/%s/remove' % gid3, {'userId': fid})
        ok(not r.get('error') and await F.wait(group_event('kick', gid3)) is not None, '后台把女移出，女实时收到', r)
        ok(conv_of(ft, cid3)['group']['state'] == 'kicked', '女的状态是「被移出」')
        M.mark()
        r = call('/im/group/%s/dissolve' % gid3, mt, {})
        ok(r.get('code') == 0 and await M.wait(group_event('dissolved', gid3)) is not None, '群主解散群聊', r)
        ok(conv_of(mt, cid3)['group']['state'] == 'dissolved', '群主的列表里状态是「已解散」')
        r = await admin('POST', '/groups/%s/closed' % gid3, {'closed': False})
        ok('解散' in str(r.get('error') or ''), '已经解散的群不能恢复', r)

        print('【10 不是成员的人】')
        g4 = await admin('POST', '/groups/test', {'owner': msid, 'name': '自测群四 ' + stamp, 'memberLimit': 2})
        gid4, cid4 = str(g4['id']), str(g4['conversationId'])
        made.append(gid4)
        ok(call('/im/group/' + gid4, ft).get('code') == 403, '没进过这个群：看不了群资料')
        ok(call('/im/messages?conversationId=%s' % cid4, ft).get('code') == 403, '看不了聊天记录')
        e = await F.send(2, gid4, '【自测】没进群就发')
        ok(e.get('op') == 'error', '发不了消息', e)
        ok(call('/im/group/%s/report' % gid4, ft, {'reason': '其他'}).get('code') == 403, '也不能举报没进过的群')
        ok(conv_of(ft, cid4) is None, '列表里没有这个群')
        ok(call('/im/group/999999999', ft).get('code') == 404, '不存在的群：404')
        e = await F.send(2, 'abc', 'x')
        ok(e.get('op') == 'error', '群 id 乱填：被拒', e)

        print('【11 单聊没被改坏】')
        F.mark()
        s = await M.send(1, fid, '【自测】加了群聊以后单聊照常 ' + stamp)
        ok(s.get('op') == 'ack', '男给女发单聊消息：发出去了', s)
        f = await F.wait(lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('id') == s.get('msgId'))
        ok(f is not None and f['data']['convType'] == 1 and 'groupId' not in f['data'], '女实时收到，是单聊', f)
        rows = call('/im/conversations', ft).get('data') or []
        ok(len([r for r in rows if r.get('type') == 1]) == singles_before and rows[0]['type'] == 1 and str(rows[0]['id']) == str(s['conversationId']), '单聊列表条数没变，刚聊的排在最前面', [(r['type'], r['id']) for r in rows][:4])
    finally:
        print('【清理：删掉测试群】')
        for g in made:
            r = await admin('POST', '/groups/%s/delete-test' % g)
            ok(not r.get('error'), '删掉测试群 %s' % g, r)
        await asyncio.sleep(1)
        left_f = [r for r in (call('/im/conversations', ft).get('data') or []) if r.get('type') == 2]
        left_m = [r for r in (call('/im/conversations', mt).get('data') or []) if r.get('type') == 2]
        ok(not left_f and not left_m, '两个号的消息列表里都没有群了', (left_f, left_m))
        lst = await admin('GET', '/groups?cat=all')
        ok(lst.get('total') == 0, '后台群列表是空的', lst)
        reps = await admin('GET', '/reports?status=0')
        ok(isinstance(reps, list) and not [x for x in reps if x.get('targetType') == 'group'], '测试时的群举报也一起删了')
        await F.close(); await M.close()
        ADMIN.close()
    print('有 %d 条不对' % fails if fails else '全部通过')
    sys.exit(1 if fails else 0)


async def restart_test():
    """
    后端重启以后，到期定时器是不是重新挂上了：建一个 50 秒后到期的测试群 → 重启后端容器 → 等它到点自己解散。
    会让后端停几秒钟（只有测试号在用的时候才跑）。
    """
    global ADMIN
    ADMIN = AdminSession()
    ft, fid, fsid, _ = enter(r'D:\hongniao\deploy\dev_f.json')
    mt, mid, msid, _ = enter(r'D:\hongniao\deploy\dev_m.json')
    gid = None
    try:
        t0 = time.time()
        g = await admin('POST', '/groups/test', {'owner': msid, 'name': '自测群 重启', 'members': [fsid], 'expireInSec': 50})
        gid, cid = str(g['id']), str(g['conversationId'])
        ok(conv_of(ft, cid)['group']['state'] == 'ok', '建了一个 50 秒后到期的测试群')
        c = beans.remote.connect()
        try:
            _, out, _ = c.exec_command('docker restart hn-api >/dev/null 2>&1; for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -m 3 -w "%{http_code}" https://gphnai.com/api/emojis)" = "200" ] && break; sleep 1; done; docker logs hn-api 2>&1 | grep -c "到期定时器"', timeout=90)
            n = out.read().decode().strip()
        finally:
            c.close()
        ok(n.isdigit() and int(n) >= 1, '重启了后端容器，启动日志里写着重新挂上了到期定时器（到这里用了 %.0f 秒）' % (time.time() - t0), n)
        ok(conv_of(ft, cid)['group']['state'] == 'ok' and time.time() - t0 < 45, '重启完还没到期，群是正常的', time.time() - t0)
        F = Conn(ft)
        await F.open()
        f = await F.wait(group_event('dissolved', gid), 70)
        took = time.time() - t0
        ok(f is not None and 48 <= took <= 56, '重启以后还是到点解散：从建群算起 %.1f 秒（定的是 50 秒）' % took, took)
        await F.close()
    finally:
        ADMIN.close()
        if gid:
            ADMIN = AdminSession()
            r = await admin('POST', '/groups/%s/delete-test' % gid)
            ok(not r.get('error'), '删掉测试群 %s' % gid, r)
            lst = await admin('GET', '/groups?cat=all')
            ok(lst.get('total') == 0, '后台群列表是空的', lst)
            ADMIN.close()
    print('有 %d 条不对' % fails if fails else '全部通过')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    asyncio.run(restart_test() if len(sys.argv) > 1 and sys.argv[1] == 'restart' else main())
