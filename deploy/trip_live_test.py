# -*- coding: utf-8 -*-
"""
在服务器上用两个测试号实测「领队旅行」后端（2026-11-28，样稿 design/13-travel.html）。
男测试号（711405）临时当领队，女测试号（997353）当用户。后台接口通过 SSH 在服务器上调（只登录一次）。
先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'。

  python deploy/trip_live_test.py          跑一遍
  python deploy/trip_live_test.py clean    只做收尾（上一次没跑完时用）

测的东西：设为领队和推送、默认领队、发布线路的检查、先审后发（不通过 / 改了再提交 / 通过后自动建群）、旅行首页、排行榜、领队页、
线路详情和按钮的几种样子、约单进群和约单记录、名额、被移出后不能再约、上架后改内容要重新审、一句话介绍的审核、返佣比例、
发布时和 AI 聊（会花男测试号一点牵豆）、推送只发给登记了的人、领队下架、取消领队时线路自动下架。

测完：自测的线路（标题以【自测】开头）和它们的群、约单记录彻底删掉；男测试号改回不是领队、比例恢复默认、介绍清空；默认领队清掉。
"""
import asyncio, json, os, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import group_live_test as T  # noqa: E402

ok, call, admin = T.ok, T.call, T.admin
VIDEO = '/res/hongniang/video/selftest-not-a-real-file.mp4'
COVER = '/res/hongniang/image/selftest-not-a-real-file.jpg'


def day(n):
    """北京时间今天往后 n 天，YYYY-MM-DD"""
    return time.strftime('%Y-%m-%d', time.gmtime(time.time() + 8 * 3600 + n * 86400))


def trip_event(event, **kw):
    def pred(f):
        d = f.get('data') or {}
        return f.get('op') == 'trip' and d.get('event') == event and all(str(d.get(k)) == str(v) for k, v in kw.items())
    return pred


async def cleanup(ft, mt, mid, msid):
    """把测试留下的东西都清掉、还原。可以反复跑"""
    lst = await admin('GET', '/trips?cat=all&size=100')
    for t in lst.get('list') or []:
        if str(t.get('title', '')).startswith('【自测】'):
            r = await admin('POST', '/trips/%s/delete-test' % t['id'])
            ok(not r.get('error'), '删掉自测线路 %s %s' % (t['id'], t['title']), r)
        else:
            print('  ！不是自测的线路，没动：%s %s' % (t['id'], t.get('title')))
    me = call('/user/me', mt).get('data') or {}
    if me.get('isLeader'):
        # 先把介绍清空（要还是领队才能改）
        mine = call('/trip/mine', mt).get('data') or {}
        if mine.get('intro') or mine.get('introPending') is not None:
            call('/trip/intro', mt, {'intro': ''})
            if (call('/trip/mine', mt).get('data') or {}).get('introPending') is not None:
                await admin('POST', '/users/%s/leader-intro' % mid, {'pass': True})
        r = await admin('POST', '/users/%s/leader' % mid, {'leader': False})
        ok(r.get('isLeader') is False, '男测试号改回不是领队', r)
    await admin('POST', '/users/%s/referral-rate' % mid, {'rate': None})
    cfg = await admin('GET', '/trip/config')
    if cfg.get('defaultLeader'):
        cfg = await admin('PUT', '/trip/config', {'defaultLeader': ''})
    row = next((u for u in ((await admin('GET', '/users?cat=all&keyword=' + msid)).get('list') or []) if str(u.get('shortId')) == msid), {})
    ok(row.get('isLeader') is False and row.get('referralRate') is None and row.get('leaderIntro') == '' and row.get('leaderIntroPending') is None,
       '男测试号：不是领队、比例是默认的、介绍是空的', {k: row.get(k) for k in ('isLeader', 'referralRate', 'leaderIntro', 'leaderIntroPending')})
    ok(cfg.get('defaultLeader') is None, '没有指定默认领队', cfg)
    left = await admin('GET', '/trips?cat=all')
    ok(not [t for t in (left.get('list') or []) if str(t.get('title', '')).startswith('【自测】')], '没有自测线路了（现在一共 %s 条线路）' % left.get('total'), left.get('total'))
    groups = await admin('GET', '/groups?cat=all')
    ok(groups.get('total') == 0, '后台群列表是空的', groups.get('total'))
    for name, tok in (('女', ft), ('男', mt)):
        ok(not [r for r in (call('/im/conversations', tok).get('data') or []) if r.get('type') == 2], '%s测试号的消息列表里没有群' % name)


async def main():
    T.ADMIN = T.AdminSession()
    ft, fid, fsid, fname = T.enter(r'D:\hongniao\deploy\dev_f.json')
    mt, mid, msid, mname = T.enter(r'D:\hongniao\deploy\dev_m.json')
    print('用户：女 %s；领队：男 %s' % (fsid, msid))
    if len(sys.argv) > 1 and sys.argv[1] == 'clean':
        await cleanup(ft, mt, mid, msid)
        T.ADMIN.close()
        sys.exit(1 if T.fails else 0)
    stamp = time.strftime('%H%M%S')
    F, M = T.Conn(ft), T.Conn(mt)
    await F.open(); await M.open()
    fields = {'title': '【自测】川西环线 7 天 ' + stamp, 'videoUrl': VIDEO, 'coverUrl': COVER, 'startDate': day(10), 'days': 7,
              'gatherPlace': '成都', 'price': 3980, 'quota': 3, 'itinerary': '第 1 天 成都 → 康定\n第 2–7 天 稻城亚丁、塔公', 'feeNote': '含车辆和住宿；不含餐费、门票'}
    try:
        print('【0 开始前】')
        ok((call('/user/me', mt).get('data') or {}).get('isLeader') is False, '男测试号现在不是领队')
        ok(call('/trip/mine', mt).get('code') == 403 and call('/trip/create', mt, fields).get('code') == 403, '不是领队：进不了领队后台、发不了线路')
        h = call('/trip/home', ft).get('data') or {}
        ok(h.get('leader') is None and h.get('trips') == [] and h.get('leaders') == 0, '女的「旅行」首页：没有领队、没有线路、排行榜是空的', h)
        ok(call('/trip/leaders', ft).get('data') == [], '排行榜是空的')

        print('【1 设为领队、默认领队】')
        M.mark()
        r = await admin('POST', '/users/%s/leader' % mid, {'leader': True})
        ok(r.get('isLeader') is True, '后台把男测试号设为领队', r)
        ok(await M.wait(trip_event('leader', on=True)) is not None, '他本人实时收到「你是领队了」')
        ok((call('/user/me', mt).get('data') or {}).get('isLeader') is True, '他的资料里 isLeader = true（「我的」页靠它显示领队后台）')
        mine = call('/trip/mine', mt).get('data') or {}
        ok(mine.get('rank') is None and mine.get('trips') == [] and mine.get('rate') == 70 and mine.get('invited') is not None, '领队后台：没上榜、没有线路、比例是默认的 70', mine)
        ok((call('/trip/home', mt).get('data') or {}).get('leader', {}).get('self') is True, '领队自己打开「旅行」：看到的是自己')
        ok((call('/trip/home', ft).get('data') or {}).get('leader') is None, '女还没有领队（不是他推荐来的，也没指定默认领队）')
        r = await admin('PUT', '/trip/config', {'defaultLeader': fid})
        ok('领队' in str(r.get('error') or ''), '不能把不是领队的人指定成默认领队', r)
        r = await admin('PUT', '/trip/config', {'defaultLeader': mid})
        ok((r.get('defaultLeader') or {}).get('shortId') == msid, '后台指定他为默认领队', r)
        h = call('/trip/home', ft).get('data') or {}
        ok((h.get('leader') or {}).get('id') == mid and h['leader']['self'] is False and h['leader']['rank'] is None, '女的「旅行」首页现在是他（没有线路，所以没有名次）', h.get('leader'))

        print('【2 发布线路：填的东西要对】')
        ok(call('/trip/create', ft, fields).get('code') == 403, '普通用户发线路：被拒')
        for k, v, why in (('startDate', day(0), '出发日期是今天'), ('videoUrl', 'https://example.com/a.mp4', '视频不是我们自己的地址'), ('feeNote', '', '没写费用'),
                          ('days', 0, '天数是 0'), ('quota', 500, '名额 500'), ('title', '短', '标题太短')):
            ok(call('/trip/create', mt, {**fields, k: v}).get('code') == 400, '%s：被拒' % why)
        r = call('/trip/create', mt, fields)
        ok(r.get('code') == 0 and r['data']['status'] == 0, '填对了：提交成功，状态是审核中', r)
        tid = str(r['data']['id'])
        ok(call('/trip/detail/' + tid, ft).get('code') == 404, '审核中的线路别人看不到')
        ok(call('/trip/detail/' + tid, mt).get('data', {}).get('btn') == 'off', '领队自己看得到（按钮是「没上架」）')
        ok((call('/trip/home', ft).get('data') or {}).get('trips') == [] and call('/trip/leaders', ft).get('data') == [], '首页没有这条线路，排行榜还是空的')
        ok((call('/trip/mine', mt).get('data') or {}).get('trips', [{}])[0].get('state') == 'reviewing', '领队后台里这条是「审核中」')

        print('【3 先审后发】')
        lst = await admin('GET', '/trips')
        row = next((t for t in (lst.get('list') or []) if str(t['id']) == tid), None)
        ok(row is not None and row['leader']['shortId'] == msid and lst['counts']['review'] >= 1, '后台「待审核」里有这条，带着是谁发的', lst.get('counts'))
        r = await admin('POST', '/trips/%s/review' % tid, {'pass': False})
        ok('原因' in str(r.get('error') or ''), '不通过不写原因：不行', r)
        M.mark()
        r = await admin('POST', '/trips/%s/review' % tid, {'pass': False, 'reason': '没写清楚费用'})
        ok(r.get('pass') is False and await M.wait(trip_event('review', tripId=tid, **{'pass': False})) is not None, '后台不通过，领队实时收到', r)
        t0 = (call('/trip/mine', mt).get('data') or {}).get('trips', [{}])[0]
        ok(t0.get('state') == 'rejected' and t0.get('rejectReason') == '没写清楚费用', '领队后台里这条是「没通过」，写着原因', t0)
        r = call('/trip/mine/%s/update' % tid, mt, {**fields, 'feeNote': '含车辆、油费、住宿、领队全程；不含餐费、门票'})
        ok(r.get('code') == 0 and r['data']['status'] == 0, '领队改了再提交：又回到审核中', r)
        ok(call('/trip/mine/%s/update' % tid, ft, fields).get('code') == 403, '别人改这条线路：被拒')
        await F.ws.send(json.dumps({'op': 'watch', 'topic': 'trip', 'on': True}))
        await asyncio.sleep(0.5)
        F.mark(); M.mark()
        r = await admin('POST', '/trips/%s/review' % tid, {'pass': True})
        ok(r.get('pass') is True, '后台通过', r)
        ok(await M.wait(trip_event('review', tripId=tid, **{'pass': True})) is not None, '领队实时收到「通过了」')
        ok(await F.wait(trip_event('trip', tripId=tid)) is not None and await F.wait(trip_event('rank')) is not None, '正停在旅行页面上的女实时收到：有线路变了、排行榜变了')
        g = await M.wait(lambda f: f.get('op') == 'group' and (f.get('data') or {}).get('event') == 'create')
        ok(g is not None and g['data']['group']['kind'] == 'trip' and str(g['data']['group']['ownerId']) == mid, '自动建好了线路群，领队是群主，类型是旅行', g and g['data'].get('group'))
        gid = str(g['data']['groupId']) if g else ''
        ok(g is not None and g['data']['group']['name'].endswith(day(10)[5:] + ' 团') and g['data']['group']['avatar'] == COVER, '群名是「…月-日 团」，群头像是线路的封面', g and g['data']['group'].get('name'))
        r = await admin('POST', '/trips/%s/review' % tid, {'pass': True})
        ok(r.get('error'), '已经审过的不能再审一次', r)

        print('【4 首页、排行榜、领队页、线路详情】')
        h = call('/trip/home', ft).get('data') or {}
        c = (h.get('trips') or [{}])[0]
        ok(len(h.get('trips') or []) == 1 and str(c.get('id')) == tid and c['orders'] == 0 and c['left'] == 3 and c['phase'] == 'open' and c['price'] == 3980, '首页有这条线路：0 人约单、还剩 3 位、招募中', c)
        ok(h['leader']['rank'] == 1 and h['leader']['trips'] == 1 and [str(x['id']) for x in h['top']] == [mid] and h['leaders'] == 1, '我的领队排第 1（榜上只有他），前三名里有他', (h.get('leader'), h.get('top')))
        b = call('/trip/leaders', ft).get('data') or []
        ok(len(b) == 1 and b[0]['rank'] == 1 and str(b[0]['id']) == mid and b[0]['mine'] is True and b[0]['orders30'] == 0 and b[0]['trips'] == 1, '排行榜：1 位，标着「我的领队」，0 人约单', b)
        p = call('/trip/leader/' + mid, ft).get('data') or {}
        ok(p.get('leader', {}).get('mine') is True and len(p.get('trips') or []) == 1, '领队页：有他的 1 条线路', p.get('leader'))
        ok(call('/trip/leader/' + fid, mt).get('code') == 404, '不是领队的人没有领队页')
        d = call('/trip/detail/' + tid, ft).get('data') or {}
        ok(d.get('btn') == 'order' and d.get('group') is None and '稻城亚丁' in d.get('itinerary', '') and '油费' in d.get('feeNote', '') and str(d['leader']['id']) == mid, '线路详情：按钮是「约单」，行程、费用（改过的那版）、领队都对', {k: d.get(k) for k in ('btn', 'group', 'feeNote')})
        ok(call('/trip/detail/' + tid, mt).get('data', {}).get('btn') == 'owner', '领队自己看：按钮是「我是领队」')

        print('【5 约单 = 进群】')
        ok(call('/trip/detail/%s/order' % tid, mt, {}).get('code') == 400, '领队约自己的线路：被拒')
        F.mark(); M.mark()
        r = call('/trip/detail/%s/order' % tid, ft, {})
        ok(r.get('code') == 0 and str(r['data']['groupId']) == gid, '女约单：成功，返回了线路群', r)
        cid = str((r.get('data') or {}).get('conversationId'))
        ok(await M.wait(trip_event('trip', tripId=tid)) is not None, '领队实时收到：有人约单了')
        ok(await F.wait(trip_event('rank')) is not None, '排行榜的变化推给了正停在页面上的女')
        ok(await M.wait(T.group_event('join', gid)) is not None, '群里：领队收到有人进群')
        row = T.conv_of(ft, cid)
        ok(row is not None and row['type'] == 2 and row['group']['kind'] == 'trip' and row['group']['state'] == 'ok' and row['group']['memberCount'] == 2, '女的消息列表里马上有这个线路群（2 人）', row and row.get('group'))
        d = call('/trip/detail/' + tid, ft).get('data') or {}
        ok(d.get('btn') == 'joined' and d['orders'] == 1 and str((d.get('group') or {}).get('conversationId')) == cid and len(d['faces']) == 1 and d['faces'][0], '线路详情：按钮变成「进入群聊」，1 人已约单，有她的头像', {k: d.get(k) for k in ('btn', 'orders', 'faces')})
        ok(call('/trip/detail/%s/order' % tid, ft, {}).get('code') == 0 and call('/trip/detail/' + tid, ft)['data']['orders'] == 1, '再点一次约单：不报错，还是 1 人（不重复记）')
        b = call('/trip/leaders', ft).get('data') or []
        ok(b and b[0]['orders30'] == 1, '排行榜上他的约单人数变成 1', b)
        mine = call('/trip/mine', mt).get('data') or {}
        ok(mine['rank'] == 1 and mine['orders30'] == 1 and mine['trips'][0]['orders'] == 1 and mine['trips'][0]['state'] == 'open', '领队后台：第 1 名、近 30 天约单 1 人、这条线路约单 1', {k: mine.get(k) for k in ('rank', 'orders30')})
        o = call('/trip/mine/%s/orders' % tid, mt).get('data') or []
        ok(len(o) == 1 and str(o[0]['id']) == fid and o[0]['inGroup'] is True and o[0]['nickname'] == fname, '约单的人：有她，还在群里', o)
        ok(call('/trip/mine/%s/orders' % tid, ft).get('code') == 403, '别人看不了约单名单')
        a = await F.send(2, gid, '【自测】约单进来的，在线路群里说话 ' + stamp)
        ok(a.get('op') == 'ack', '女在线路群里能发消息', a)

        print('【6 名额领队自己管】')
        ok(call('/trip/mine/%s/quota' % tid, mt, {'confirmed': 9}).get('code') == 400, '已定人数比总名额多：被拒')
        F.mark()
        r = call('/trip/mine/%s/quota' % tid, mt, {'confirmed': 3})
        ok(r.get('code') == 0 and r['data']['left'] == 0, '领队把已定人数改成 3（满了）', r)
        ok(await F.wait(trip_event('trip', tripId=tid)) is not None, '女实时收到这条线路变了')
        d = call('/trip/detail/' + tid, ft).get('data') or {}
        ok(d['left'] == 0 and d['btn'] == 'joined', '详情：还剩 0 位；已经在群里的人不受影响，还是「进入群聊」', (d['left'], d['btn']))
        ok(call('/im/group/%s/leave' % gid, ft, {}).get('code') == 0 and call('/trip/detail/' + tid, ft)['data']['btn'] == 'full', '她退群以后再看：按钮是「名额已满」')
        ok(call('/trip/detail/%s/order' % tid, ft, {}).get('code') == 400, '名额满了约单：被拒')
        r = call('/trip/mine/%s/quota' % tid, mt, {'quota': 5, 'confirmed': 1})
        ok(r.get('code') == 0 and r['data'] == {'quota': 5, 'confirmed': 1, 'left': 4}, '领队把总名额改成 5、已定 1', r)
        ok(call('/trip/detail/%s/order' % tid, ft, {}).get('code') == 0 and call('/trip/detail/' + tid, ft)['data']['orders'] == 1, '她重新约单：又进群了，约单人数还是 1')
        o = call('/trip/mine/%s/orders' % tid, mt).get('data') or []
        ok(len(o) == 1 and o[0]['inGroup'] is True, '约单名单还是 1 个人')
        ok(call('/im/group/%s/kick' % gid, mt, {'userId': fid}).get('code') == 0, '领队把她移出线路群')
        d = call('/trip/detail/' + tid, ft).get('data') or {}
        ok(d['btn'] == 'blocked' and d['group'] is None and d['orders'] == 1, '她再看：按钮是「不能约单」；约单记录不删（还是 1）', (d['btn'], d['orders']))
        ok(call('/trip/detail/%s/order' % tid, ft, {}).get('code') == 403, '被移出的人再约单：被拒')
        ok((call('/trip/mine/%s/orders' % tid, mt).get('data') or [{}])[0].get('inGroup') is False, '约单名单里她标成「不在群里了」')

        print('【7 上架后改内容要重新审】')
        r = call('/trip/mine/%s/update' % tid, mt, {**fields, 'price': 4200, 'title': '【自测】川西环线 7 天改 ' + stamp})
        ok(r.get('code') == 0 and r['data']['pending'] is True, '领队改了价格和标题：进了待审核', r)
        d = call('/trip/detail/' + tid, mt).get('data') or {}
        ok(d['price'] == 3980 and d['status'] == 1, '审核期间别人看到的还是原来的价格 3980', d.get('price'))
        ok((call('/trip/mine', mt).get('data') or {})['trips'][0]['hasPending'] is True, '领队后台里标着「改了在等审核」')
        lst = await admin('GET', '/trips')
        row = next((t for t in (lst.get('list') or []) if str(t['id']) == tid), None)
        ok(row is not None and (row.get('pending') or {}).get('price') == 4200 and row['price'] == 3980, '后台待审核里有它：原来 3980，要改成 4200', row and row.get('pending'))
        r = await admin('POST', '/trips/%s/review' % tid, {'pass': False, 'reason': '价格改得太多'})
        d = (call('/trip/mine', mt).get('data') or {})['trips'][0]
        ok(r.get('pass') is False and d['price'] == 3980 and d['hasPending'] is False and d['state'] == 'open' and d['rejectReason'] == '价格改得太多', '不通过：线路照旧在招募，新内容丢掉，原因给领队看', d)
        call('/trip/mine/%s/update' % tid, mt, {**fields, 'price': 4200, 'feeNote': '含车辆、油费、住宿；不含餐费、门票'})
        F.mark()
        r = await admin('POST', '/trips/%s/review' % tid, {'pass': True})
        d = call('/trip/detail/' + tid, mt).get('data') or {}
        ok(r.get('pass') is True and d['price'] == 4200 and (call('/trip/mine', mt).get('data') or {})['trips'][0]['hasPending'] is False, '再改一次、通过：价格变成 4200', d.get('price'))
        ok(await F.wait(trip_event('trip', tripId=tid)) is not None, '正停在页面上的女实时收到线路变了')

        print('【8 一句话介绍、返佣比例】')
        ok(call('/trip/intro', mt, {'intro': '字' * 61}).get('code') == 400, '介绍超过 60 个字：被拒')
        r = call('/trip/intro', mt, {'intro': '【自测】川西跑了 6 年'})
        ok(r.get('code') == 0 and r['data']['introPending'] == '【自测】川西跑了 6 年' and r['data']['intro'] == '', '领队改介绍：先等审核，页面上还是原来的（空）', r)
        ok(call('/trip/leader/' + mid, ft)['data']['leader']['intro'] == '', '别人看领队页：还没有介绍')
        lst = await admin('GET', '/trips')
        ok(any(str(u['id']) == mid for u in (lst.get('intros') or [])), '后台待审核里有这条介绍')
        r = await admin('POST', '/users/%s/leader-intro' % mid, {'pass': True})
        ok(r.get('pass') is True and call('/trip/leader/' + mid, ft)['data']['leader']['intro'] == '【自测】川西跑了 6 年', '后台通过：领队页上有介绍了', r)
        r = await admin('POST', '/users/%s/referral-rate' % mid, {'rate': 101})
        ok(r.get('error'), '比例填 101：被拒', r)
        r = await admin('POST', '/users/%s/referral-rate' % mid, {'rate': 90})
        ok(r.get('rate') == 90 and (call('/trip/mine', mt).get('data') or {}).get('rate') == 90, '后台把他的比例设成 90，领队后台显示 90', r)
        r = await admin('POST', '/users/%s/referral-rate' % fid, {'rate': 80})
        ok(r.get('referralRate') == 80, '不是领队的人也能单独设比例（80）', r)
        r = await admin('POST', '/users/%s/referral-rate' % fid, {'rate': None})
        ok(r.get('referralRate') is None and r.get('rate') == 70, '恢复默认：变回 70', r)

        print('【9 发布线路时和 AI 聊（花男测试号一点牵豆）】')
        ok(call('/trip/ai', ft, {'text': '川西环线'}).get('code') == 403, '不是领队不能用')
        r = call('/trip/ai', mt, {'text': '川西环线 7 天，%s 月 %s 号成都出发，3980 起，收 14 个人' % (int(day(20)[5:7]), int(day(20)[8:10])), 'draft': {}})
        if r.get('code') == 0:
            dr, miss = r['data']['draft'], r['data']['missing']
            ok(dr.get('days') == 7 and dr.get('price') == 3980 and dr.get('quota') == 14 and '成都' in str(dr.get('gatherPlace')) and dr.get('startDate') == day(20),
               'AI 认出了：7 天、3980、14 人、成都、出发日期', dr)
            ok('feeNote' in miss and r['data']['reply'], '没说的（费用）列在「还差」里，并且回了一句话：%s' % r['data']['reply'], miss)
            r2 = call('/trip/ai', mt, {'text': '含车和住宿，不含餐和门票。第一天到康定，后面去稻城亚丁和塔公', 'draft': dr})
            d2 = (r2.get('data') or {}).get('draft') or {}
            ok(r2.get('code') == 0 and d2.get('price') == 3980 and d2.get('feeNote') and d2.get('itinerary') and (r2['data']['missing'] == []), '再说一句：之前认出来的留着，费用和行程补上了，不差了', (r2.get('data') or {}).get('missing'))
        else:
            ok(False, 'AI 那一步没测成（%s %s）' % (r.get('code'), r.get('reason') or r.get('msg')), r)

        print('【10 推送只发给登记了的人】')
        await F.ws.send(json.dumps({'op': 'watch', 'topic': 'trip', 'on': False}))
        await asyncio.sleep(0.5)
        F.mark(); M.mark()
        call('/trip/mine/%s/quota' % tid, mt, {'confirmed': 2})
        ok(await M.wait(trip_event('trip', tripId=tid), 4) is not None, '领队自己收到（他是这条线路的领队）')
        ok(await F.wait(trip_event('trip', tripId=tid), 3) is None, '女已经离开旅行页面（取消登记）：不再收到')

        print('【11 领队下架、取消领队】')
        ok(call('/trip/mine/%s/off' % tid, ft, {}).get('code') == 403, '别人下架：被拒')
        M.mark()
        r = call('/trip/mine/%s/off' % tid, mt, {})
        ok(r.get('code') == 0 and await M.wait(T.group_event('dissolved', gid)) is not None, '领队下架：线路群当场解散', r)
        ok(call('/trip/detail/' + tid, ft).get('code') == 404 and (call('/trip/home', ft).get('data') or {}).get('trips') == [] and call('/trip/leaders', ft).get('data') == [], '线路从首页拿掉了；没有招募中的线路，他也不在榜上了')
        ok((call('/trip/mine', mt).get('data') or {})['trips'][0]['state'] == 'off', '领队后台里这条是「已下架」')
        ok(call('/trip/mine/%s/update' % tid, mt, fields).get('code') == 400, '下架的线路不能再改')
        r = call('/trip/create', mt, {**fields, 'title': '【自测】阿拉善穿沙 5 天 ' + stamp, 'days': 5})
        tid2 = str(r['data']['id'])
        r = call('/trip/create', mt, {**fields, 'title': '【自测】审核中的那条 ' + stamp})
        tid3 = str(r['data']['id'])
        await admin('POST', '/trips/%s/review' % tid2, {'pass': True})
        gid2 = str(((await admin('GET', '/trips?cat=on')).get('list') or [{}])[0].get('groupId'))
        ok(call('/trip/detail/%s/order' % tid2, ft, {}).get('code') == 0, '又上架一条，女约了单（进了第二个群）')
        F.mark(); M.mark()
        r = await admin('POST', '/users/%s/leader' % mid, {'leader': False})
        ok(r.get('isLeader') is False and r.get('offTrips') == 1, '后台取消领队：告诉你下架了 1 条线路', r)
        ok(await M.wait(trip_event('leader', on=False)) is not None, '他本人实时收到「不是领队了」')
        ok(await F.wait(T.group_event('dissolved', gid2)) is not None, '那条线路的群解散了，群里的女实时收到')
        ok(call('/trip/mine', mt).get('code') == 403 and (call('/user/me', mt).get('data') or {}).get('isLeader') is False, '他进不了领队后台了')
        lst = await admin('GET', '/trips?cat=all&size=100')
        st = {str(t['id']): (t['status'], t.get('rejectReason')) for t in lst.get('list') or []}
        ok(st.get(tid2, (None,))[0] == 4 and st.get(tid3) == (2, '已经不是领队'), '上架中的那条变成「平台下架」，审核中的那条退回了', (st.get(tid2), st.get(tid3)))
        cfg = await admin('GET', '/trip/config')
        ok(cfg.get('defaultLeader') is None and (call('/trip/home', ft).get('data') or {}).get('leader') is None, '默认领队跟着清掉了，女的首页又没有领队了', cfg)
        ok(call('/trip/leader/' + mid, ft).get('code') == 404, '他的领队页打不开了')
        r = await admin('POST', '/users/%s/leader' % mid, {'leader': True})
        mine = call('/trip/mine', mt).get('data') or {}
        ok(r.get('isLeader') is True and mine.get('rate') == 90 and mine.get('intro') == '【自测】川西跑了 6 年', '重新设为领队：比例（90）和介绍都还在', {k: mine.get(k) for k in ('rate', 'intro')})
    finally:
        print('【收尾：全部还原】')
        await cleanup(ft, mt, mid, msid)
        await F.close(); await M.close()
        T.ADMIN.close()
    print('有 %d 条不对' % T.fails if T.fails else '全部通过')
    sys.exit(1 if T.fails else 0)


if __name__ == '__main__':
    asyncio.run(main())
