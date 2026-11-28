# -*- coding: utf-8 -*-
"""
「显示在广场」开关（2026-11-28，用户要求：后台用户列表里一个开关，不分角色）。

这个开关后端本来就有：user.hidden（后台「隐藏」），接口 POST /api/admin/users/:id/hidden { hidden }。
不显示在广场 = hidden 为 true。它管的地方：广场 → 遇见的全部小标签、广场 → 动态、每日推荐、消息页搜索用户（按昵称、按 6 位 ID 都搜不到）。
不受影响的：已有的聊天、关注、群；这个人自己照常能看广场、能聊天、能点喜欢；别人知道他的画像页地址（群里点头像、聊天页）照常能打开。

网页后台做出来之前，先用这个脚本操作。在本机运行，通过 SSH 到服务器上调后台接口；管理员密码在服务器上取，不打印、不离开服务器。
先设好 $env:HN_PW（取法见 AI进度文档.md §7）和 $env:PYTHONIOENCODING='utf-8'。

  python deploy/plaza.py hide <短号> [短号 …]   这些人不显示在广场
  python deploy/plaza.py show <短号> [短号 …]   这些人重新显示在广场
  python deploy/plaza.py list                   现在哪些人不显示在广场
  python deploy/plaza.py test                   用两个测试号（女 997353、男 711405）实测这个开关：
                                                临时把男测试号设成不显示，看女测试号那边各处还有没有他，再改回来。
                                                过程中男测试号会发一条测试动态，测完删掉。
"""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import group_live_test as T  # noqa: E402  （借它的 AdminSession：一条 SSH 连接只登录后台一次）


def find(s, short_id):
    """按 6 位短号找到用户那一行（后台用户列表）"""
    r = s.call('GET', '/users?cat=all&keyword=' + urllib.request.quote(str(short_id)))
    rows = [u for u in (r.get('list') or []) if str(u.get('shortId')) == str(short_id)]
    return rows[0] if rows else None


def set_hidden(s, short_id, hidden):
    u = find(s, short_id)
    if not u:
        print('  ✗ 没有短号是 %s 的用户' % short_id)
        return False
    r = s.call('POST', '/users/%s/hidden' % u['id'], {'hidden': hidden})
    ok = r.get('hidden') is hidden
    print(('  ✓ ' if ok else '  ✗ ') + '%s（%s）%s' % (short_id, u.get('nickname'), '不显示在广场' if hidden else '显示在广场') + ('' if ok else '  ← %s' % r))
    return ok


def cmd_list(s):
    r = s.call('GET', '/users?cat=hidden&size=100')
    rows = r.get('list') or []
    print('现在不显示在广场的有 %d 人%s' % (r.get('total', len(rows)), '：' if rows else ''))
    for u in rows:
        print('  %s  %s  %s%s' % (u.get('shortId'), u.get('nickname'), '男' if u.get('gender') == 1 else '女', '  （已封禁）' if u.get('status') else ''))


def cmd_test(s):
    ft, fid, fsid, fname = T.enter(r'D:\hongniao\deploy\dev_f.json')
    mt, mid, msid, mname = T.enter(r'D:\hongniao\deploy\dev_m.json')
    print('看的人：女 %s；被开关的人：男 %s' % (fsid, msid))
    stamp = time.strftime('%H%M%S')
    me_m = T.call('/user/me', mt).get('data') or {}
    city = me_m.get('cityName') or ''

    def meet(token, tab):
        q = '?tab=%s' % tab + ('&city=' + urllib.request.quote(city) if tab == 'city' and city else '')
        return [str(u.get('id')) for u in (T.call('/user/meet/list' + q, token).get('data') or [])]

    def feed_ids(token):
        return [str(x.get('id')) for x in (T.call('/moments/feed', token).get('data') or [])]

    def search_users(token, q):
        return [str(u.get('id')) for u in ((T.call('/im/search?q=' + urllib.request.quote(q), token).get('data') or {}).get('users') or [])]

    def today(token):
        return [str((x.get('user') or {}).get('id') or x.get('id')) for x in ((T.call('/match/today', token).get('data') or {}).get('list') or [])]

    def convs_with(token, peer):
        return [c for c in (T.call('/im/conversations', token).get('data') or []) if str((c.get('peer') or {}).get('id')) == peer]

    row = find(s, msid)
    T.ok(row is not None and row.get('hidden') is False, '开始前：男测试号是「显示在广场」的', row and row.get('hidden'))
    moment_id = None
    tabs = ('all', 'new', 'city', 'intimacy')
    try:
        # 男测试号发一条测试动态（测「动态」那个 tab 用），测完删掉
        r = T.call('/moments', mt, {'type': 1, 'content': '【自测】广场显示开关 ' + stamp})
        moment_id = str((r.get('data') or {}).get('id') or '') or None
        T.ok(moment_id is not None, '男测试号发了一条测试动态', r)

        print('【开着的时候（显示在广场）】')
        before = {t: mid in meet(ft, t) for t in tabs}
        T.ok(before['all'] and before['new'], '女看「遇见」综合、新人：有他', before)
        print('    同城（%s）：%s；亲密度：%s' % (city or '没填城市', '有他' if before['city'] else '没有他', '有他' if before['intimacy'] else '没有他'))
        if moment_id:
            T.ok(moment_id in feed_ids(ft), '女看「动态」：有他刚发的那条')
        T.ok(mid in search_users(ft, mname), '女按昵称搜：搜得到他')
        T.ok(mid in search_users(ft, msid), '女按 6 位 ID 搜：搜得到他')
        today_before = today(ft)
        print('    女今天的每日推荐里%s他（两个测试号已经互相喜欢，本来就不会互相推荐）' % ('有' if mid in today_before else '没有'))

        print('【关掉（不显示在广场）】')
        T.ok(set_hidden(s, msid, True), '后台把男测试号设成不显示')
        after = {t: mid in meet(ft, t) for t in tabs}
        T.ok(not any(after.values()), '女看「遇见」综合 / 新人 / 同城 / 亲密度：都没有他了', after)
        if moment_id:
            T.ok(moment_id not in feed_ids(ft), '女看「动态」：他那条不见了')
            T.ok(moment_id not in [str(x.get('id')) for x in (T.call('/moments/feed?follow=1', ft).get('data') or [])], '女看「动态」只看关注的：也没有他那条')
        T.ok(mid not in search_users(ft, mname), '女按昵称搜：搜不到他')
        T.ok(mid not in search_users(ft, msid), '女按 6 位 ID 搜：也搜不到他')
        T.ok(mid not in today(ft), '女今天的每日推荐里没有他')
        hid = s.call('GET', '/users?cat=hidden&size=100')
        T.ok(any(str(u.get('shortId')) == msid for u in (hid.get('list') or [])), '后台按「已隐藏」筛，列表里有他')

        print('【关掉以后不受影响的】')
        T.ok(len(convs_with(ft, mid)) == 1 and len(convs_with(mt, fid)) == 1, '两个人的聊天还在各自的消息列表里')
        r = T.call('/user/%s' % mid, ft)
        T.ok(r.get('code') == 0 and str((r.get('data') or {}).get('id')) == mid, '女照常能打开他的主页（知道地址就能看）', r.get('code'))
        r = T.call('/match/relation/%s' % mid, ft)
        T.ok(r.get('code') == 0 and (r.get('data') or {}).get('state') == 'mutual', '两个人还是互相喜欢', r)
        T.ok(fid in meet(mt, 'all'), '他自己看「遇见」：照常看得到别人')
        T.ok(T.call('/moments/feed', mt).get('code') == 0 and (T.call('/match/today', mt).get('code') == 0), '他自己看「动态」、每日推荐：照常能打开')
        if moment_id:
            mine = [str(x.get('id')) for x in (T.call('/moments/mine', mt).get('data') or [])]
            T.ok(moment_id in mine, '他自己的动态里那条还在')

        print('【重新打开（显示在广场）】')
        T.ok(set_hidden(s, msid, False), '后台把男测试号改回显示')
        again = {t: mid in meet(ft, t) for t in tabs}
        T.ok(again == before, '女看「遇见」各小标签：和一开始一样', (again, before))
        if moment_id:
            T.ok(moment_id in feed_ids(ft), '女看「动态」：他那条又出现了')
        T.ok(mid in search_users(ft, mname) and mid in search_users(ft, msid), '女按昵称、按 6 位 ID 搜：又搜得到他')
    finally:
        print('【收尾】')
        row = find(s, msid)
        if row is None or row.get('hidden') is not False:
            set_hidden(s, msid, False)
            row = find(s, msid)
        T.ok(row is not None and row.get('hidden') is False, '男测试号现在是「显示在广场」的')
        if moment_id:
            req = T.call('/moments/%s' % moment_id, mt, method='DELETE')
            T.ok(req.get('code') == 0 and moment_id not in feed_ids(ft), '删掉测试动态', req)
        hid = s.call('GET', '/users?cat=hidden&size=100')
        print('  现在不显示在广场的有 %s 人' % hid.get('total'))
    print('有 %d 条不对' % T.fails if T.fails else '全部通过')
    return 1 if T.fails else 0


def main():
    a = sys.argv[1:]
    op = a[0] if a else ''
    if op not in ('hide', 'show', 'list', 'test') or (op in ('hide', 'show') and len(a) < 2):
        print(__doc__)
        return 0
    s = T.AdminSession()
    try:
        if op == 'list':
            cmd_list(s)
            return 0
        if op == 'test':
            return cmd_test(s)
        ok = all([set_hidden(s, sid, op == 'hide') for sid in a[1:]])
        return 0 if ok else 1
    finally:
        s.close()


if __name__ == '__main__':
    sys.exit(main())
