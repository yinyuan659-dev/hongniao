# -*- coding: utf-8 -*-
"""
在安卓模拟器里看「领队旅行」时，替平台（后台还没做）和另一个测试号配戏（2026-11-28）。
男测试号（711405）当领队，女测试号（997353）当用户。一次可以写几个动作，按顺序做，后台只登录一次：

  python deploy/trip_emu_drive.py leader:on default:on     把男测试号设为领队，并指定成默认领队（女的旅行页上就是他）
  python deploy/trip_emu_drive.py create approve           男测试号发一条自测线路（带一个真的 6 秒视频和封面），后台通过
  python deploy/trip_emu_drive.py reject                   后台不通过（原因「自测：不通过」）
  python deploy/trip_emu_drive.py order                    女测试号约最新那条上架的自测线路（进群）
  python deploy/trip_emu_drive.py show                     现在什么样
  python deploy/trip_emu_drive.py leader:off               取消领队
  python deploy/trip_emu_drive.py clean                    全部还原（同 trip_live_test.py clean）

先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'；create 要有 ffmpeg。
"""
import asyncio, json, os, subprocess, sys, tempfile, time, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import group_live_test as T  # noqa: E402
import trip_live_test as L  # noqa: E402


def upload(kind, path, mime, token):
    """照网页的做法传一个文件（multipart），返回 /res/… 地址"""
    boundary = uuid.uuid4().hex
    head = ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\nContent-Type: %s\r\n\r\n' % (boundary, os.path.basename(path), mime)).encode()
    body = head + open(path, 'rb').read() + ('\r\n--%s--\r\n' % boundary).encode()
    req = urllib.request.Request(T.BASE + '/api/upload/' + kind, data=body, method='POST',
                                 headers={'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Authorization': 'Bearer ' + token})
    r = json.loads(T.op.open(req, timeout=120).read().decode('utf-8'))
    if r.get('code') != 0:
        raise SystemExit('上传失败：%s' % r)
    return r['data']['url']


def make_media():
    tmp = tempfile.gettempdir()
    video, cover = os.path.join(tmp, 'hn_trip_selftest.mp4'), os.path.join(tmp, 'hn_trip_selftest.jpg')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x406:rate=24', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
                    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-c:a', 'aac', '-movflags', '+faststart', video], check=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', video, '-frames:v', '1', '-q:v', '4', cover], check=True)
    return video, cover


def selftest_trips(admin, cat):
    lst = admin.call('GET', '/trips?cat=%s&size=100' % cat)
    return [t for t in (lst.get('list') or []) if str(t.get('title', '')).startswith('【自测】')]


def main():
    acts = sys.argv[1:]
    if not acts:
        raise SystemExit(__doc__)
    admin = T.AdminSession()
    T.ADMIN = admin
    ft, fid, fsid, fname = T.enter(os.path.join(HERE, 'dev_f.json'))
    mt, mid, msid, mname = T.enter(os.path.join(HERE, 'dev_m.json'))
    try:
        for a in acts:
            if a in ('leader:on', 'leader:off'):
                r = admin.call('POST', '/users/%s/leader' % mid, {'leader': a.endswith('on')})
                print('%s → 男测试号 isLeader=%s%s' % (a, r.get('isLeader'), '，下架了 %s 条线路' % r.get('offTrips') if r.get('offTrips') else ''), r.get('error') or '')
            elif a in ('default:on', 'default:off'):
                r = admin.call('PUT', '/trip/config', {'defaultLeader': mid if a.endswith('on') else ''})
                print('%s → 默认领队：%s' % (a, (r.get('defaultLeader') or {}).get('shortId')), r.get('error') or '')
            elif a == 'create':
                video, cover = make_media()
                v, c = upload('video', video, 'video/mp4', mt), upload('image', cover, 'image/jpeg', mt)
                r = T.call('/trip/create', mt, {'title': '【自测】川西环线 7 天 ' + time.strftime('%H%M'), 'videoUrl': v, 'coverUrl': c, 'startDate': L.day(10), 'days': 7,
                                                'gatherPlace': '成都', 'price': 3980, 'quota': 6, 'itinerary': '第 1 天 成都 → 康定\n第 2–7 天 稻城亚丁、塔公',
                                                'feeNote': '含车辆、油费、住宿、领队全程；不含餐费、门票'})
                print('create → 线路 %s（审核中）' % (r.get('data') or {}).get('id'), '' if r.get('code') == 0 else r)
            elif a in ('approve', 'reject'):
                rows = selftest_trips(admin, 'review')
                if not rows:
                    print('%s → 没有待审核的自测线路' % a)
                for t in rows:
                    r = admin.call('POST', '/trips/%s/review' % t['id'], {'pass': True} if a == 'approve' else {'pass': False, 'reason': '自测：不通过'})
                    print('%s → 线路 %s %s' % (a, t['id'], '通过' if r.get('pass') else '不通过'), r.get('error') or '')
            elif a == 'order':
                rows = selftest_trips(admin, 'on')
                if not rows:
                    print('order → 没有上架的自测线路')
                else:
                    r = T.call('/trip/detail/%s/order' % rows[0]['id'], ft, {})
                    print('order → 女测试号约了线路 %s，群 %s' % (rows[0]['id'], (r.get('data') or {}).get('groupId')), '' if r.get('code') == 0 else r)
            elif a == 'show':
                me = T.call('/user/me', mt).get('data') or {}
                print('男测试号 isLeader=%s' % me.get('isLeader'))
                if me.get('isLeader'):
                    mine = T.call('/trip/mine', mt).get('data') or {}
                    print('  领队后台：名次 %s，线路 %s' % (mine.get('rank'), [(t['id'], t['title'], t['state'], '约单 %s' % t['orders']) for t in mine.get('trips') or []]))
                h = T.call('/trip/home', ft).get('data') or {}
                print('女测试号的旅行页：领队 %s，线路 %s' % ((h.get('leader') or {}).get('nickname'), [(t['id'], t['title']) for t in h.get('trips') or []]))
                for name, tok in (('女', ft), ('男', mt)):
                    gs = [r['group']['name'] + '（' + r['group']['state'] + '）' for r in (T.call('/im/conversations', tok).get('data') or []) if r.get('type') == 2]
                    print('%s测试号消息列表里的群：%s' % (name, gs))
            elif a == 'clean':
                T.fails = 0
                asyncio.run(L.cleanup(ft, mt, mid, msid))
            else:
                print('不认识的动作：' + a)
    finally:
        admin.close()


if __name__ == '__main__':
    main()
