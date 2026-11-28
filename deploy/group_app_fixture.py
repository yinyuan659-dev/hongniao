# -*- coding: utf-8 -*-
"""
给 App（安卓 / iOS）的群聊解析测试取一份「测试服务器真实返回」的样本（2026-11-27）。

原生端没法在这台电脑上跑起来看，最容易出错的是「服务器给的数据 App 认不认得」：消息列表里群那一行、群资料、
群的推送、群里的消息、搜索结果、被拒绝时的原因。这个脚本用两个测试号（女 997353、男 711405，男是群主）在服务器上
真的建一个测试群、走一遍，把每一步服务器返回的原样存成 JSON：
    android/app/src/test/resources/group_fixture.json
安卓的单元测试 GroupFixtureTest 用 App 自己的解析代码去读它（gradlew :app:testDebugUnitTest）。

样本里有：两个测试号的用户 id、昵称、头像地址、测试群的名字和消息。没有登录令牌、设备号、密码。
测试群（kind=test）测完彻底删掉，不留在服务器上。只动这两个测试号。接口变了以后重新跑一次这个脚本再跑单元测试。

先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'（取法见 AI进度文档.md §7）。
  python deploy/group_app_fixture.py
"""
import asyncio, json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import group_live_test as T  # noqa: E402

OUT = r'D:\hongniao\android\app\src\test\resources\group_fixture.json'


def data(path, token, body=None):
    r = T.call(path, token, body)
    if r.get('code') != 0:
        raise SystemExit('接口失败 %s：%s' % (path, r))
    return r.get('data')


async def need(conn, pred, what, timeout=8):
    f = await conn.wait(pred, timeout)
    if f is None:
        raise SystemExit('没等到推送：' + what)
    return f


async def main():
    T.ADMIN = T.AdminSession()
    ft, fid, fsid, fname = T.enter(r'D:\hongniao\deploy\dev_f.json')
    mt, mid, msid, mname = T.enter(r'D:\hongniao\deploy\dev_m.json')
    stamp = time.strftime('%H%M%S')
    F, M = T.Conn(ft), T.Conn(mt)
    await F.open(); await M.open()
    made = []
    fx = {
        'note': 'deploy/group_app_fixture.py 从测试服务器取的真实返回，%s。重新生成：python deploy/group_app_fixture.py' % time.strftime('%Y-%m-%d %H:%M'),
        'memberId': fid, 'memberName': fname, 'ownerId': mid, 'ownerName': mname, 'frames': {},
    }
    fr = fx['frames']
    try:
        # 1 建群（3 天后到期：endAt = 现在，expireAt = 3 天后，App 里应该提示「3 天后自动解散」）
        F.mark(); M.mark()
        g = await T.admin('POST', '/groups/test', {'owner': msid, 'name': '样本群 ' + stamp, 'members': [fsid], 'expireInSec': 259200})
        if g.get('error') or not g.get('id'):
            raise SystemExit('建测试群失败：%s' % g)
        gid, cid = str(g['id']), str(g['conversationId'])
        made.append(gid)
        fx['groupId'], fx['conversationId'] = gid, cid
        fr['create'] = await need(M, T.group_event('create', gid), '群主：群建好了')
        fr['join'] = await need(F, T.group_event('join', gid), '成员：进群了')
        fr['sysJoin'] = await need(M, T.sys_msg(gid, 'join'), '群主：灰色小字「加入了群聊」')

        # 2 收发
        M.mark()
        a = await F.send(2, gid, '样本：成员在群里说话 ' + stamp)
        fr['ack'] = a
        fr['msg'] = await need(M, lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('id') == a.get('msgId'), '群主：收到成员的消息')
        F.mark()
        b = await M.send(2, gid, '样本：群主回复 ' + stamp, reply_to=a['msgId'])
        fr['msgReply'] = await need(F, lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('id') == b.get('msgId'), '成员：收到群主的回复')
        data('/im/messages/%s/react' % b['msgId'], ft, {'emoji': '❤️'})
        data('/im/messages/%s/pin' % a['msgId'], mt, {'pin': True})

        # 3 两边的消息列表（连单聊那几行一起，原样）、群资料、聊天记录、置顶、搜索
        fx['convsMember'] = data('/im/conversations', ft)
        fx['convsOwner'] = data('/im/conversations', mt)
        fx['viewMember'] = data('/im/group/' + gid, ft)
        fx['viewOwner'] = data('/im/group/' + gid, mt)
        fx['messagesMember'] = data('/im/messages?conversationId=%s' % cid, ft)
        fx['pins'] = data('/im/conversations/%s/pins' % cid, ft)
        fx['search'] = data('/im/search?q=' + urllib.request.quote('群主回复 ' + stamp), ft)

        # 4 群主改群名、写公告；成员开免打扰以后群主再说一句（成员那一行：有未读、是免打扰）
        F.mark()
        fx['update'] = data('/im/group/%s/update' % gid, mt, {'name': '样本群改名 ' + stamp, 'notice': '早上 7 点集合\n带身份证'})
        fr['info'] = await need(F, lambda x: T.group_event('info', gid)(x) and x['data']['group']['notice'] != '', '成员：群名和公告改了')
        fx['mute'] = data('/im/group/%s/mute' % gid, ft, {'muted': True})
        F.mark()
        c = await M.send(2, gid, '样本：免打扰以后群主说的 ' + stamp)
        await need(F, lambda x: x.get('op') == 'msg' and (x.get('data') or {}).get('id') == c.get('msgId'), '成员：收到群主的消息')
        fx['convsMemberMuted'] = data('/im/conversations', ft)

        # 5 群主把成员移出；被移出的人再发消息、再点表情
        F.mark(); M.mark()
        data('/im/group/%s/kick' % gid, mt, {'userId': fid})
        fr['kick'] = await need(F, T.group_event('kick', gid), '成员：被移出了')
        seen = await M.wait(T.group_event('kick', gid), 5)
        if seen is not None:
            fr['kickSeenByOwner'] = seen
        fr['errorLeft'] = await F.send(2, gid, '样本：被移出后发，应该发不出去')
        fx['http403'] = T.call('/im/messages/%s/react' % b['msgId'], ft, {'emoji': '👍'})
        fx['convsKicked'] = data('/im/conversations', ft)
        fx['viewKicked'] = data('/im/group/' + gid, ft)

        # 6 群主解散
        M.mark()
        data('/im/group/%s/dissolve' % gid, mt, {})
        fr['dissolved'] = await need(M, T.group_event('dissolved', gid), '群主：群解散了')
        fx['convsDissolved'] = data('/im/conversations', mt)
        fx['viewDissolved'] = data('/im/group/' + gid, mt)
        fr['errorDissolved'] = await M.send(2, gid, '样本：解散后发，应该发不出去')

        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(fx, f, ensure_ascii=False, indent=1)
            f.write('\n')
        print('样本已写到 ' + OUT + '（%d 字节）' % os.path.getsize(OUT))
        print('  推送和帧：' + '、'.join(sorted(fr.keys())))
    finally:
        print('【清理：删掉测试群】')
        for x in made:
            r = await T.admin('POST', '/groups/%s/delete-test' % x)
            T.ok(not r.get('error'), '删掉测试群 %s' % x, r)
        await asyncio.sleep(1)
        left_f = [r for r in (T.call('/im/conversations', ft).get('data') or []) if r.get('type') == 2]
        left_m = [r for r in (T.call('/im/conversations', mt).get('data') or []) if r.get('type') == 2]
        T.ok(not left_f and not left_m, '两个号的消息列表里都没有群了', (left_f, left_m))
        lst = await T.admin('GET', '/groups?cat=all')
        T.ok(lst.get('total') == 0, '后台群列表是空的', lst)
        await F.close(); await M.close()
        T.ADMIN.close()
    sys.exit(1 if T.fails else 0)


if __name__ == '__main__':
    asyncio.run(main())
