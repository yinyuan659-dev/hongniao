# -*- coding: utf-8 -*-
"""
网页端群聊界面的实测（2026-11-27，样稿 design/12-group.html）：两个测试号（女 997353、男 711405）各开一个 360 宽的手机浏览器，
真的点、真的发，看另一边是不是不刷新就跟着变。会建 2 个测试群（kind=test，男是群主），测完彻底删掉。

  python deploy/group_web_test.py            测本机刚构建的 web/dist（页面文件用本机的，接口和 WebSocket 连测试服务器）
  python deploy/group_web_test.py live       测已经部署到服务器上的网页

先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'；本机模式要先 cd web; npm run build。
截图存到 design/live/group-web-*.png。
"""
import json, os, sys, time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import group_live_test as T  # noqa: E402  （只用里面的 AdminSession、enter；它的 main 不会跑）

ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, 'web', 'dist')
SHOTS = os.path.join(ROOT, 'design', 'live')
SITE = 'https://gphnai.com'
LIVE = len(sys.argv) > 1 and sys.argv[1] == 'live'
fails = 0


def ok(cond, label, detail=''):
    global fails
    if not cond:
        fails += 1
    print(('  ✓ ' if cond else '  ✗ ') + label + (('  ← ' + str(detail)[:300]) if (detail != '' and not cond) else ''))
    return cond


def device_id(path):
    dev = json.load(open(path, encoding='utf-8'))
    return dev.get('deviceId') or dev.get('device_id') or next(v for v in dev.values() if isinstance(v, str) and v.startswith('web_'))


def serve_local(route):
    """页面文件（首页、assets）用本机 web/dist 里的，其余（接口、上传的文件、WebSocket）照常走服务器"""
    u = urlparse(route.request.url)
    if u.hostname != 'gphnai.com' or u.path.startswith(('/api/', '/res/', '/ws', '/app/', '/rtc/')):
        return route.continue_()
    f = os.path.join(DIST, 'index.html' if u.path in ('/', '/index.html') else u.path.lstrip('/').replace('/', os.sep))
    if os.path.isfile(f):
        return route.fulfill(path=f)
    return route.continue_()


def open_user(browser, dev_path, errors, who):
    ctx = browser.new_context(viewport={'width': 360, 'height': 700}, device_scale_factor=2, is_mobile=True, has_touch=False)
    ctx.add_init_script("localStorage.setItem('pw_device_id', %s)" % json.dumps(device_id(dev_path)))
    if not LIVE:
        ctx.route('**/*', serve_local)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('%s: %s' % (who, str(e)[:200])))
    page.goto(SITE + '/')
    page.wait_for_url('**/#/plaza', timeout=20000)
    return page


def go(page, hash_path):
    page.evaluate('h => { location.hash = h }', hash_path)
    page.wait_for_timeout(600)


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, name))


def visible(page, text, timeout=8000):
    try:
        page.get_by_text(text, exact=False).first.wait_for(state='visible', timeout=timeout)
        return True
    except Exception:
        return False


def send(page, text):
    box = page.locator('input.input').last
    box.fill(text)
    box.press('Enter')


def main():
    admin = T.AdminSession()
    _, fid, fsid, fname = T.enter(os.path.join(HERE, 'dev_f.json'))
    _, mid, msid, mname = T.enter(os.path.join(HERE, 'dev_m.json'))
    print('%s：女 %s（%s）/ 男 %s（%s，群主）' % ('服务器上的网页' if LIVE else '本机 web/dist', fsid, fname, msid, mname))
    made, errors = [], []
    name1, name2 = '川西环线 12-06 团', '龙泉山日出徒步'
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True, args=['--no-proxy-server', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'])
        try:
            g = admin.call('POST', '/groups/test', {'owner': msid, 'name': name1, 'members': [fsid]})
            gid = str(g['id']); made.append(gid)
            F = open_user(b, os.path.join(HERE, 'dev_f.json'), errors, '女')
            M = open_user(b, os.path.join(HERE, 'dev_m.json'), errors, '男')
            if not LIVE:
                js = [s for s in F.evaluate("[...document.scripts].map(s => s.src)") if '/assets/' in s]
                local = [f for f in os.listdir(os.path.join(DIST, 'assets')) if f.endswith('.js')]
                ok(js and os.path.basename(urlparse(js[0]).path) in local, '页面跑的是本机刚构建的那一份', (js, local))

            print('【1 消息列表】')
            go(M, '#/chat')
            M.locator('.cl-row', has_text=name1).first.click()
            ok(visible(M, '%s（2）' % name1), '群主点群进聊天页，标题是「群名（2）」')
            send(M, '欢迎，这趟 6 台车。你是自己开车还是坐车？')
            ok(visible(M, '欢迎，这趟 6 台车'), '群主发了一条')
            go(F, '#/chat')
            row = F.locator('.cl-row', has_text=name1).first
            row.wait_for(state='visible', timeout=8000)
            txt = row.inner_text()
            ok('测试' in txt and ('%s：欢迎' % mname) in txt, '女的消息列表里有这个群：有小标签，预览是「谁：说了什么」', txt)
            ok(row.locator('.cs-badge').count() == 1 and row.locator('.cs-badge').inner_text() == '1', '未读 1')
            box = row.locator('div').first.bounding_box()
            ok(abs(box['width'] - 54) < 1 and row.locator('div').first.evaluate("e => getComputedStyle(e).borderRadius") != '50%', '群头像是方的圆角')
            shot(F, 'group-web-1-list.png')

            print('【2 群聊页】')
            row.click()
            ok(visible(F, '%s（2）' % name1), '女进聊天页，标题带人数')
            ok(visible(F, '加入了群聊'), '中间有一行灰色小字「加入了群聊」')
            ok(F.locator('.bubble-wrap .small', has_text='群主').count() >= 1, '群主的昵称后面有红色小标（测试群叫「群主」；线路群是「领队」，活动群是「发起人」）')
            send(F, '坐车，一个人。高反严重吗？')
            ok(visible(M, '坐车，一个人'), '群主那边不刷新就收到了')
            send(M, '车上有氧气瓶。定金 500，出发前 3 天付尾款')
            ok(visible(F, '车上有氧气瓶'), '女这边也实时收到')
            F.wait_for_timeout(800)
            meta = ' '.join(F.locator('.bubble-row.mine .msg-meta').all_inner_texts())
            ok('已读' not in meta and '未读' not in meta, '群里自己的消息下面没有「已读 / 未读」', meta)
            ok(F.locator('.hn-tip').count() == 0, '群聊页没有单聊那条「你们还没有互相喜欢」的提示')
            F.locator('input.input').last.blur() if False else None
            shot(F, 'group-web-2-chat.png')
            F.get_by_text('+', exact=True).last.click()
            F.wait_for_timeout(700)
            sheet = F.locator('.att-sheet').inner_text()
            ok('通话' not in sheet, '「+」里没有语音 / 视频通话', sheet)
            F.locator('.att-mask').click(position={'x': 10, 'y': 10})
            F.wait_for_timeout(500)

            print('【3 群资料：成员】')
            F.locator('.nav-more-btn').click()
            ok(visible(F, '群资料') and visible(F, '退出群聊'), '右上角「···」进群资料，最下面是「退出群聊」')
            body = F.locator('.hn-page').inner_text()
            ok('举报这个群' in body and '消息免打扰' in body and '群名' not in body and '编辑' not in body and '移出' not in body, '成员看到：免打扰、举报这个群；没有群名、编辑、移出', body)
            ok('2 人' in body and mname in body, '写着 2 人、群主是谁', body)
            shot(F, 'group-web-3-info-member.png')

            print('【4 群资料：群主，改公告和群名，另一边跟着变】')
            M.locator('.nav-more-btn').click()
            ok(visible(M, '解散群聊') and visible(M, '还没有写群公告') and M.get_by_text('编辑', exact=True).count() == 1 and M.locator('[data-act="kick-mode"]').count() == 1, '群主看到：解散群聊、群名、编辑公告、移出')
            ok('举报这个群' not in M.locator('.hn-page').inner_text(), '群主没有「举报这个群」')
            M.get_by_text('编辑', exact=True).click()
            M.locator('.hn-dialog textarea').fill('12 月 6 日早 7 点成都南站东广场集合。带身份证、厚外套、常用药。')
            M.get_by_role('button', name='保存').click()
            ok(visible(M, '早 7 点成都南站'), '群主写了群公告')
            ok(visible(F, '早 7 点成都南站'), '女的群资料页不刷新就出现了新公告（推送）')
            M.get_by_text('群名', exact=False).first.click()
            M.locator('.hn-dialog input').fill('川西环线 12-06 团（改）')
            M.get_by_role('button', name='保存').click()
            ok(visible(F, '川西环线 12-06 团（改）'), '群主改群名，女那边不刷新就变了')
            name1b = '川西环线 12-06 团（改）'
            shot(M, 'group-web-4-info-owner.png')

            print('【5 免打扰】')
            F.locator('.hn-switch').click()
            F.wait_for_timeout(800)
            ok('on' in (F.locator('.hn-switch').get_attribute('class') or ''), '女打开消息免打扰')
            go(F, '#/chat')
            F.wait_for_timeout(1200)
            tab_before = F.locator('.tabbar .tab', has_text='消息').inner_text()
            M.go_back()
            ok(visible(M, '%s（2）' % name1b), '群主回到聊天页，标题已经是新群名')
            send(M, '免打扰的时候发的一条')
            row = F.locator('.cl-row', has_text=name1b).first
            F.wait_for_timeout(1500)
            ok(visible(F, '免打扰的时候发的一条') and row.locator('.cs-badge').count() == 0, '女的列表里预览更新了，但没有红色数字（只有一个灰点）', row.inner_text())
            tab = F.locator('.tabbar .tab', has_text='消息').inner_text()
            ok(tab == tab_before, '底部「消息」上的数字没有因为这条变多（免打扰的群不计入）', (tab_before, tab))
            shot(F, 'group-web-5-list-muted.png')

            print('【6 被移出】')
            row.click()
            ok(visible(F, '免打扰的时候发的一条'), '女回到群聊页')
            M.locator('.nav-more-btn').click()
            M.locator('[data-act="kick-mode"]').click()
            ok(visible(M, '点要移出的人'), '群主点「移出」，进入移出模式')
            M.locator('.hn-scroll').get_by_text(fname, exact=True).click()
            ok(visible(M, '把 %s 移出群聊？' % fname), '点了人先问一句')
            M.locator('.hn-dialog').get_by_role('button', name='移出').click()
            ok(visible(F, '你已不在这个群里'), '女的聊天页不刷新，输入框换成「你已不在这个群里」')
            ok(visible(F, '被群主移出了群聊'), '中间出一行「被群主移出了群聊」')
            F.wait_for_timeout(500)
            title = F.locator('.navbar .title').inner_text()
            ok('（' not in title.replace('（改）', ''), '被移出以后标题不显示人数', title)
            ok(F.locator('input.input').count() == 0, '没有输入框了')
            shot(F, 'group-web-6-kicked.png')
            M.wait_for_timeout(600)
            ok('1 人' in M.locator('.hn-page').inner_text() and M.locator('.hn-scroll').get_by_text(fname, exact=True).count() == 0, '群主的群资料里人数变成 1、名单里没有她了')
            F.locator('.nav-more-btn').click()
            ok(visible(F, '从消息列表里删除') and '退出群聊' not in F.locator('.hn-page').inner_text(), '被移出的人进群资料：只有「从消息列表里删除」')
            F.get_by_text('从消息列表里删除', exact=True).last.click()
            F.locator('.hn-dialog').get_by_role('button', name='删除').click()
            F.wait_for_url('**/#/chat', timeout=8000)
            F.wait_for_timeout(1000)
            ok(F.locator('.cl-row', has_text=name1b).count() == 0, '删掉以后回到消息列表，这个群不在了')

            print('【7 快到期的提示、到点解散】')
            g2 = admin.call('POST', '/groups/test', {'owner': msid, 'name': name2, 'members': [fsid], 'expireInSec': 30})
            gid2 = str(g2['id']); made.append(gid2)
            t0 = time.time()
            row2 = F.locator('.cl-row', has_text=name2).first
            row2.wait_for(state='visible', timeout=8000)
            ok(True, '新群不刷新就出现在女的消息列表里')
            row2.click()
            ok(visible(F, '自动解散') and F.locator('input.input').count() == 1, '结束时间过了、还没解散：输入框上面有一条「…后自动解散」，照常能发')
            send(F, '周六 9 点 B 口见')
            ok(visible(F, '周六 9 点 B 口见'), '这时候还能发消息')
            shot(F, 'group-web-7-ending.png')
            ok(visible(F, '这个群已解散', timeout=45000), '到点了（建群后 %.0f 秒）：不刷新，输入框换成「这个群已解散」' % (time.time() - t0))
            ok(visible(F, '自动解散', timeout=3000) and F.locator('input.input').count() == 0, '中间出一行「群聊已到期，自动解散」，输入框没了')
            shot(F, 'group-web-8-dissolved.png')
            go(F, '#/chat')
            F.wait_for_timeout(800)
            ok(F.locator('.cl-row', has_text=name2).count() == 1, '解散的群还留在消息列表里')

            print('【8 单聊没被改坏】')
            F.locator('.cl-row:has(.avatar)', has_text=mname).first.click()
            F.wait_for_timeout(1200)
            ok(F.locator('.navbar .title').inner_text() == mname, '女点开和男的单聊，标题是对方昵称（没有人数）')
            line = '【自测】网页单聊照常 ' + time.strftime('%H:%M:%S')
            send(F, line)
            go(M, '#/chat')
            ok(visible(M, line), '女在单聊里发一条，男的消息列表不刷新就出现')
            F.wait_for_timeout(800)
            meta = ' '.join(F.locator('.bubble-row.mine .msg-meta').all_inner_texts())
            ok('未读' in meta or '已读' in meta, '单聊里自己的消息下面还是有「已读 / 未读」', meta[-40:])
            F.locator('.nav-more-btn').click()
            ok(visible(F, '不合适，不再联系', 3000) and F.locator('.hn-page').count() == 0, '单聊右上角「···」还是原来的菜单（没有跳去群资料）')
            ok(not errors, '两个页面全程没有脚本报错', errors)
        finally:
            b.close()
            print('【清理：删掉测试群】')
            for x in made:
                r = admin.call('POST', '/groups/%s/delete-test' % x)
                ok(not r.get('error'), '删掉测试群 %s' % x, r)
            lst = admin.call('GET', '/groups?cat=all')
            ok(lst.get('total') == 0, '后台群列表是空的', lst)
            admin.close()
    print('有 %d 条不对' % fails if fails else '全部通过')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
