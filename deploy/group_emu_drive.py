# -*- coding: utf-8 -*-
"""
在模拟器 / 真机上看群聊时，替「另一个测试号」和后台配戏（2026-11-27）。
手机上登着一个测试号，这个脚本用另一个测试号（或者后台）在测试服务器上做动作，看手机上的页面是不是不刷新就跟着变。
只动两个测试号（女 997353、男 711405）；建的都是测试群（kind=test），用完 delete 彻底删掉。
先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'。记着现在是哪个群的小文件在 %TEMP%\\hn_emu\\group.json。

  python deploy/group_emu_drive.py create <群名> [几秒后到期]   后台建测试群：男是群主，女是成员（要用后台，登录一次）
  python deploy/group_emu_drive.py say m|f <一句话>             男 / 女在群里说一句
  python deploy/group_emu_drive.py say1 m|f <一句话>            单聊：男 / 女给另一个测试号发一句（不用先建群）
  python deploy/group_emu_drive.py rename <新群名>              群主（男）改群名
  python deploy/group_emu_drive.py notice <公告>                群主（男）写公告
  python deploy/group_emu_drive.py mute f|m on|off              开 / 关免打扰
  python deploy/group_emu_drive.py kick                         群主（男）把女移出
  python deploy/group_emu_drive.py leave                        女退出群聊
  python deploy/group_emu_drive.py add                          女重新进群（后台，登录一次）
  python deploy/group_emu_drive.py dissolve                     群主（男）解散
  python deploy/group_emu_drive.py closed on|off                平台关闭 / 恢复（后台，登录一次）
  python deploy/group_emu_drive.py show f|m                     看这个号的消息列表里群那一行、群资料（服务器上现在的样子）
  python deploy/group_emu_drive.py delete                       把所有测试群彻底删掉（后台，登录一次）

后台登录 5 分钟只让登 10 次，带「后台」的命令别连着敲太多。
"""
import asyncio, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import group_live_test as T  # noqa: E402

STATE = os.path.join(os.environ['TEMP'], 'hn_emu', 'group.json')
DEV = {'f': r'D:\hongniao\deploy\dev_f.json', 'm': r'D:\hongniao\deploy\dev_m.json'}


def state():
    try:
        return json.load(open(STATE, encoding='utf-8'))
    except Exception:
        raise SystemExit('还没有建群：先 create')


def who(k):
    tok, uid, sid, name = T.enter(DEV[k])
    return {'tok': tok, 'id': uid, 'sid': sid, 'name': name}


def post(path, token, body=None):
    r = T.call(path, token, body if body is not None else {})
    print(('  ✓ ' if r.get('code') == 0 else '  ✗ ') + path + ('' if r.get('code') == 0 else '  ← %s' % r))
    return r


def admin_once(method, path, body=None):
    s = T.AdminSession()
    try:
        return s.call(method, path, body)
    finally:
        s.close()


async def say(k, text):
    st, u = state(), who(k)
    c = T.Conn(u['tok'])
    await c.open()
    r = await c.send(2, st['gid'], text)
    await c.close()
    print(('  ✓ ' if r.get('op') == 'ack' else '  ✗ ') + '%s 在群里说：%s' % (u['name'], text) + ('' if r.get('op') == 'ack' else '  ← %s' % r))


def main():
    a = sys.argv[1:]
    op = a[0] if a else ''
    if op == 'create' and len(a) > 1:
        f, m = who('f'), who('m')
        body = {'owner': m['sid'], 'name': a[1], 'members': [f['sid']]}
        if len(a) > 2:
            body['expireInSec'] = int(a[2])
        g = admin_once('POST', '/groups/test', body)
        if g.get('error') or not g.get('id'):
            raise SystemExit('建群失败：%s' % g)
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        json.dump({'gid': str(g['id']), 'cid': str(g['conversationId'])}, open(STATE, 'w', encoding='utf-8'))
        print('  ✓ 建了测试群 %s（会话 %s）：群主 %s，成员 %s' % (g['id'], g['conversationId'], m['name'], f['name']))
    elif op == 'say' and len(a) > 2 and a[1] in DEV:
        asyncio.run(say(a[1], a[2]))
    elif op == 'say1' and len(a) > 2 and a[1] in DEV:
        # 单聊：这个号给另一个测试号发一句
        async def one():
            u, peer = who(a[1]), who('f' if a[1] == 'm' else 'm')
            c = T.Conn(u['tok'])
            await c.open()
            r = await c.send(1, peer['id'], a[2])
            await c.close()
            print(('  ✓ ' if r.get('op') == 'ack' else '  ✗ ') + '%s 单聊发给 %s：%s' % (u['name'], peer['name'], a[2]))
        asyncio.run(one())
    elif op == 'rename' and len(a) > 1:
        post('/im/group/%s/update' % state()['gid'], who('m')['tok'], {'name': a[1]})
    elif op == 'notice' and len(a) > 1:
        post('/im/group/%s/update' % state()['gid'], who('m')['tok'], {'notice': a[1].replace('\\n', '\n')})
    elif op == 'mute' and len(a) > 2 and a[1] in DEV:
        post('/im/group/%s/mute' % state()['gid'], who(a[1])['tok'], {'muted': a[2] == 'on'})
    elif op == 'kick':
        post('/im/group/%s/kick' % state()['gid'], who('m')['tok'], {'userId': who('f')['id']})
    elif op == 'leave':
        post('/im/group/%s/leave' % state()['gid'], who('f')['tok'])
    elif op == 'add':
        r = admin_once('POST', '/groups/%s/add' % state()['gid'], {'who': who('f')['sid']})
        print(('  ✗ ' if r.get('error') else '  ✓ ') + '女重新进群' + ('  ← %s' % r if r.get('error') else ''))
    elif op == 'dissolve':
        post('/im/group/%s/dissolve' % state()['gid'], who('m')['tok'])
    elif op == 'closed' and len(a) > 1:
        r = admin_once('POST', '/groups/%s/closed' % state()['gid'], {'closed': a[1] == 'on'})
        print(('  ✗ ' if r.get('error') else '  ✓ ') + ('平台关闭' if a[1] == 'on' else '平台恢复') + ('  ← %s' % r if r.get('error') else ''))
    elif op == 'show' and len(a) > 1 and a[1] in DEV:
        st, u = state(), who(a[1])
        row = T.conv_of(u['tok'], st['cid'])
        print(json.dumps(row, ensure_ascii=False, indent=1))
        print(json.dumps(T.call('/im/group/' + st['gid'], u['tok']).get('data'), ensure_ascii=False, indent=1))
    elif op == 'delete':
        s = T.AdminSession()
        try:
            lst = s.call('GET', '/groups?cat=all&size=100')
            for g in lst.get('list') or []:
                if g.get('kind') == 'test':
                    r = s.call('POST', '/groups/%s/delete-test' % g['id'])
                    print(('  ✗ ' if r.get('error') else '  ✓ ') + '删掉测试群 %s %s' % (g['id'], g['name']))
            left = s.call('GET', '/groups?cat=all')
            print('  后台群列表现在有 %s 个群' % left.get('total'))
        finally:
            s.close()
        try:
            os.remove(STATE)
        except OSError:
            pass
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
