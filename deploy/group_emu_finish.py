# -*- coding: utf-8 -*-
"""
模拟器 / 真机上测完群聊以后的收尾（2026-11-27）：只登录后台一次，
先看一眼还没处理的举报里有哪些是测试群里的（核对 App 上点的举报到没到服务器），再把所有测试群彻底删掉，最后核对服务器上没有群了。
先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'。
  python deploy/group_emu_finish.py
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import group_live_test as T  # noqa: E402

s = T.AdminSession()
try:
    reps = s.call('GET', '/reports?status=0')
    if isinstance(reps, list):
        mine = [r for r in reps if r.get('targetType') == 'group' or (r.get('targetType') == 'message' and (r.get('message') or {}).get('convType') == 2)]
        print('还没处理的举报里，群 / 群消息的有 %d 条：' % len(mine))
        for r in mine:
            print('  · %s  原因：%s  %s' % (r.get('targetType'), r.get('reason'), ((r.get('message') or {}).get('content') or (r.get('group') or {}).get('name') or '')[:30]))
    else:
        print('取举报列表失败：%s' % reps)
    lst = s.call('GET', '/groups?cat=all&size=100')
    for g in lst.get('list') or []:
        if g.get('kind') == 'test':
            r = s.call('POST', '/groups/%s/delete-test' % g['id'])
            T.ok(not r.get('error'), '删掉测试群 %s %s' % (g['id'], g['name']), r)
        else:
            print('  ！不是测试群，没动：%s %s' % (g['id'], g['name']))
    left = s.call('GET', '/groups?cat=all')
    T.ok(left.get('total') == 0, '后台群列表是空的', left)
    reps = s.call('GET', '/reports?status=0')
    T.ok(isinstance(reps, list) and not [r for r in reps if r.get('targetType') == 'group' or (r.get('targetType') == 'message' and (r.get('message') or {}).get('convType') == 2)], '测试时的群举报也一起删了')
finally:
    s.close()
for k, path in (('女', r'D:\hongniao\deploy\dev_f.json'), ('男', r'D:\hongniao\deploy\dev_m.json')):
    tok = T.enter(path)[0]
    rows = [r for r in (T.call('/im/conversations', tok).get('data') or []) if r.get('type') == 2]
    T.ok(not rows, '%s测试号的消息列表里没有群了' % k, rows)
try:
    os.remove(os.path.join(os.environ['TEMP'], 'hn_emu', 'group.json'))
except OSError:
    pass
sys.exit(1 if T.fails else 0)
