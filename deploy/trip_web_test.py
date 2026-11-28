# -*- coding: utf-8 -*-
"""
网页端「领队旅行」的实测（2026-11-28，样稿 design/13-travel.html）：两个测试号各开一个 360 宽的手机浏览器真的点。
男测试号（711405）临时当领队，女测试号（997353）当用户；平台那一边（设领队、审核）后台还没做，由脚本通过 SSH 调后台接口代替。

  python deploy/trip_web_test.py            测本机刚构建的 web/dist（页面文件用本机的，接口和 WebSocket 连测试服务器）
  python deploy/trip_web_test.py live       测已经部署到服务器上的网页

先设好 $env:HN_PW 和 $env:PYTHONIOENCODING='utf-8'；本机模式要先 cd web; npm run build。要有 ffmpeg（现做一个 6 秒的小 MP4 当带队视频）。
截图存到 design/live/trip-web-*.png。会花男测试号一点牵豆（发布时和 AI 聊一句）。
测完：自测线路和它的群、约单记录删掉，男测试号改回不是领队（用的是 trip_live_test.py 的收尾）。
传上去的那个小视频和封面图会留在服务器的文件目录里（各一个，几十 KB），没有接口能删。
"""
import asyncio, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import group_live_test as T  # noqa: E402
import group_web_test as W  # noqa: E402  （open_user、go、shot、visible、ok；它的 main 不会跑）
import trip_live_test as L  # noqa: E402  （day、cleanup）

ok, go, shot, visible = W.ok, W.go, W.shot, W.visible


def make_video():
    """现做一个 6 秒、720×406、带一条静音音轨的 MP4"""
    path = os.path.join(tempfile.gettempdir(), 'hn_trip_selftest.mp4')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x406:rate=24', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
                    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-c:a', 'aac', '-movflags', '+faststart', path], check=True)
    return path


def text_of(page, sel='.hn-page'):
    return page.locator(sel).last.inner_text()


def wait_text(page, sel, want, timeout=8000):
    """等 sel 里出现 want（不刷新页面）"""
    try:
        page.locator(sel, has_text=want).first.wait_for(state='visible', timeout=timeout)
        return True
    except Exception:
        return False


def main():
    video = make_video()
    admin = T.AdminSession()
    T.ADMIN = admin
    ft, fid, fsid, fname = T.enter(os.path.join(HERE, 'dev_f.json'))
    mt, mid, msid, mname = T.enter(os.path.join(HERE, 'dev_m.json'))
    print('%s：用户 女 %s（%s）/ 领队 男 %s（%s）；测试视频 %d KB' % ('服务器上的网页' if W.LIVE else '本机 web/dist', fsid, fname, msid, mname, os.path.getsize(video) // 1024))
    stamp = time.strftime('%H%M%S')
    title = '【自测】川西环线 7 天 ' + stamp
    errors = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(channel='msedge', headless=True, args=['--no-proxy-server', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable', '--autoplay-policy=no-user-gesture-required'])
            try:
                ok((T.call('/user/me', mt).get('data') or {}).get('isLeader') is False, '开始前：男测试号不是领队')
                F = W.open_user(b, os.path.join(HERE, 'dev_f.json'), errors, '女')
                M = W.open_user(b, os.path.join(HERE, 'dev_m.json'), errors, '男')

                print('【1 大厅两个 tab、还没有领队的时候】')
                go(F, '#/hall')
                tabs = F.locator('.tp-tt span').all_inner_texts()
                ok(tabs == ['旅行', '相亲活动'] and 'on' in (F.locator('.tp-tt span').first.get_attribute('class') or ''), '大厅顶上是两个 tab「旅行 / 相亲活动」，默认停在旅行', tabs)
                ok(visible(F, '还没有领队发布线路') and F.locator('[data-act="leaderboard"]').count() == 0, '还没有领队：一句「还没有领队发布线路」，没有排行榜入口')
                F.locator('.tp-tt [data-tab="event"]').click()
                ok(visible(F, '相亲活动即将开放'), '点「相亲活动」：即将开放')
                go(F, '#/chat'); go(F, '#/hall')
                ok(visible(F, '相亲活动即将开放'), '去别的页再回来，还停在「相亲活动」（记住了）')
                F.locator('.tp-tt [data-tab="trip"]').click()
                ok(visible(F, '还没有领队发布线路'), '点回「旅行」')
                shot(F, 'trip-web-1-hall-empty.png')

                print('【2 设为领队：「我的」页当场多出「领队后台」】')
                go(M, '#/me')
                M.wait_for_timeout(1200)
                ok(M.get_by_text('领队后台', exact=True).count() == 0, '不是领队：「我的」页没有「领队后台」')
                r = admin.call('POST', '/users/%s/leader' % mid, {'leader': True})
                ok(r.get('isLeader') is True, '（后台）把男测试号设为领队', r)
                ok(visible(M, '领队后台'), '他的「我的」页不刷新就多出「领队后台」一行')
                r = admin.call('PUT', '/trip/config', {'defaultLeader': mid})
                ok((r.get('defaultLeader') or {}).get('shortId') == msid, '（后台）指定他为默认领队', r)
                go(F, '#/chat'); go(F, '#/hall')
                ok(wait_text(F, '[data-act="my-leader"]', mname) and '我的领队' in F.locator('[data-act="my-leader"]').inner_text(), '女的旅行页最上面是他，标着「我的领队」')
                ok(visible(F, '现在没有正在招募的线路') and F.locator('[data-act="leaderboard"]').count() == 0, '他还没有线路：写着「现在没有正在招募的线路」，榜上没人所以没有排行榜入口')

                print('【3 领队后台、发布线路（自己填）】')
                M.get_by_text('领队后台', exact=True).click()
                ok(visible(M, '还没有线路'), '点「领队后台」进去：还没有线路')
                body = text_of(M)
                ok('未上榜' in body and '70%' in body and '通过我注册' in body and '近 30 天约单' in body, '四个数：未上榜、近 30 天约单、通过我注册、推荐奖励比例 70%', body)
                shot(M, 'trip-web-2-leader-home-empty.png')
                M.locator('[data-act="publish"]').click()
                ok(visible(M, '把带队视频发进来') and M.locator('[data-act="to-form"]').count() == 1, '点「发布线路」：默认是和 AI 聊，右上角有「自己填」')
                ok(visible(M, '还剩', 6000), '底下写着这次 AI 用了多少牵豆、还剩多少')
                M.locator('[data-act="to-form"]').click()
                ok(M.locator('[data-f="title"]').count() == 1 and M.locator('[data-act="to-ai"]').count() == 1, '切到表单，右上角变成「AI 帮我填」')
                M.locator('[data-act="submit"]').click()
                ok(visible(M, '先选带队视频'), '没选视频就提交：提示先选视频')
                M.locator('input[type=file]').set_input_files(video)
                try:
                    M.locator('.tp-up.shade').wait_for(state='visible', timeout=60000)
                    up = True
                except Exception:
                    up = False
                ok(up, '选了一个 6 秒的 MP4：传上去了，那一块换成封面')
                cover = M.locator('.tp-up.shade').evaluate("e => getComputedStyle(e).backgroundImage") if up else ''
                ok('/res/' in cover, '封面是从视频第一帧取的（已经传到服务器）', cover)
                M.locator('[data-f="title"]').fill(title)
                M.locator('[data-f="startDate"]').fill(L.day(10))
                M.locator('[data-f="days"]').fill('7')
                M.locator('[data-f="gatherPlace"]').fill('成都')
                M.locator('[data-f="price"]').fill('3980')
                M.locator('[data-f="quota"]').fill('3')
                M.locator('[data-f="itinerary"]').fill('第 1 天 成都 → 康定\n第 2–7 天 稻城亚丁、塔公')
                M.locator('[data-act="submit"]').click()
                ok(visible(M, '还没填：费用'), '少填一项（费用）：提示还没填哪一项')
                M.locator('[data-f="feeNote"]').fill('含车辆和住宿')
                shot(M, 'trip-web-3-publish-form.png')
                M.locator('[data-act="submit"]').click()
                ok(visible(M, '已提交，平台审核通过后上架'), '都填了：提交成功')
                M.wait_for_url('**/#/leader', timeout=8000)
                row = M.locator('[data-mine]').first
                row.wait_for(state='visible', timeout=8000)
                tid = row.get_attribute('data-mine')
                ok(title in row.inner_text() and '平台审核中' in row.inner_text() and row.locator('.tp-st').inner_text() == '审核中', '回到领队后台，线路在列表里，标着「审核中」', row.inner_text())
                go(F, '#/chat'); go(F, '#/hall')
                F.wait_for_timeout(1000)
                ok(F.locator('[data-trip]').count() == 0, '审核中的线路，女的旅行页上看不到')

                print('【4 先审后发：不通过 → 改了再提交 → 通过】')
                r = admin.call('POST', '/trips/%s/review' % tid, {'pass': False, 'reason': '费用没写清楚不含什么'})
                ok(r.get('pass') is False, '（后台）不通过，写了原因', r)
                ok(wait_text(M, '[data-mine]', '费用没写清楚不含什么') and M.locator('[data-mine] .tp-st').first.inner_text() == '没通过', '领队后台不刷新就变成「没通过」，原因写在下面')
                M.locator('[data-mine]').first.click()
                ok(visible(M, '费用没写清楚不含什么。改好以后点下面「改线路内容」再提交一次') and M.locator('[data-act="off"]').inner_text() == '撤回这条线路', '点进这条线路：红底写着原因；最下面是「撤回这条线路」')
                shot(M, 'trip-web-4-rejected.png')
                M.locator('[data-act="edit"]').click()
                M.locator('[data-f="title"]').wait_for(state='visible', timeout=8000)
                ok(M.locator('[data-f="title"]').input_value() == title and M.locator('[data-f="price"]').input_value() == '3980' and M.locator('.tp-up.shade').count() == 1 and M.locator('[data-act="to-ai"]').count() == 0,
                   '点「改线路内容」：原来填的都带出来了（标题、价格、视频），这时候没有「AI 帮我填」')
                M.locator('[data-f="feeNote"]').fill('含车辆、油费、住宿、领队全程；不含餐费、门票')
                M.locator('[data-act="submit"]').click()
                M.wait_for_url('**/#/leader', timeout=8000)
                ok(wait_text(M, '[data-mine]', '平台审核中'), '改了再提交：又回到「审核中」')
                r = admin.call('POST', '/trips/%s/review' % tid, {'pass': True})
                ok(r.get('pass') is True, '（后台）通过', r)
                ok(wait_text(M, '[data-mine] .tp-st', '招募中') and '剩 3 位' in M.locator('[data-mine]').first.inner_text(), '领队后台不刷新就变成「招募中」，约单 0、剩 3 位', M.locator('[data-mine]').first.inner_text())
                ok(wait_text(M, '.tp-g4', '第 1 名'), '领队后台的名次不刷新就变成「第 1 名」')
                card = F.locator('[data-trip="%s"]' % tid)
                try:
                    card.wait_for(state='visible', timeout=8000)
                except Exception:
                    pass
                ct = card.inner_text() if card.count() else ''
                ok(title in ct and '成都集合' in ct and '7 天' in ct and '0 人已约单' in ct and '还剩 3 位' in ct and '¥3,980' in ct, '女正停在旅行页上：不刷新，线路卡出现了（日期、集合地、天数、约单人数、名额、价格都有）', ct)
                ok(F.locator('[data-act="leaderboard"]').count() == 1 and '排行榜第 1 名' in F.locator('[data-act="my-leader"]').inner_text(), '排行榜入口出现了，我的领队那一行写着「排行榜第 1 名」', F.locator('[data-act="my-leader"]').inner_text())
                cv = card.locator('.tp-cv').evaluate("e => getComputedStyle(e).backgroundImage") if card.count() else ''
                ok('/res/' in cv, '线路卡上是视频封面', cv)
                F.wait_for_timeout(600)
                shot(F, 'trip-web-5-hall.png')

                print('【5 排行榜 → 领队页 → 线路详情】')
                F.locator('[data-act="leaderboard"]').click()
                rk = F.locator('[data-leader="%s"]' % mid)
                rk.wait_for(state='visible', timeout=8000)
                rt = rk.inner_text()
                ok(F.locator('.tp-rk').count() == 1 and rt.startswith('1') and mname in rt and '我的领队' in rt and '1 条线路' in rt and '0\n人约单' in rt, '排行榜：1 位，第 1 名，标着「我的领队」，1 条线路，0 人约单', rt)
                shot(F, 'trip-web-6-leaderboard.png')
                rk.click()
                ok(visible(F, '他的线路') and visible(F, '认证领队'), '点这一行进他的领队页')
                body = text_of(F)
                ok('第 1 名' in body and '近 30 天约单' in body and '招募中的线路' in body and F.locator('[data-act="chat"]').count() == 1 and F.locator('[data-trip]').count() == 1, '领队页：名次、近 30 天约单、招募中的线路、「发消息」、他的 1 条线路', body)
                shot(F, 'trip-web-7-leader.png')
                F.locator('[data-trip="%s"]' % tid).click()
                btn = F.locator('[data-act="trip-btn"]')
                btn.wait_for(state='visible', timeout=8000)
                body = text_of(F)
                ok(btn.inner_text() == '约单' and btn.get_attribute('data-btn') == 'order', '点线路进详情，底下的按钮是「约单」')
                ok(title in body and '稻城亚丁' in body and '不含餐费、门票' in body and '0 人已约单 · 名额 3，还剩 3 位' in body and '约单 = 进这条线路的群' in body, '详情：标题、行程、费用（改过的那版）、约单人数和名额、按钮旁边的说明', body)
                try:
                    F.wait_for_function("() => { const v = document.querySelector('video.tp-video'); return v && v.readyState >= 1 && v.duration > 5; }", timeout=20000)
                    dur = F.evaluate("document.querySelector('video.tp-video').duration")
                except Exception:
                    dur = 0
                ok(5 < dur < 7, '视频是能放的：浏览器读出了时长（%.1f 秒）' % dur)
                F.evaluate("document.querySelector('video.tp-video').muted = true; document.querySelector('video.tp-video').play()")
                F.wait_for_timeout(1500)
                ok(F.evaluate("document.querySelector('video.tp-video').currentTime") > 0.3, '点了能播（播放位置在往前走）')
                F.evaluate("document.querySelector('video.tp-video').pause()")
                shot(F, 'trip-web-8-detail.png')

                print('【6 约单 = 进群】')
                M.locator('[data-mine]').first.click()
                M.locator('[data-info="confirmed"]').wait_for(state='visible', timeout=8000)
                btn.click()
                ok(visible(F, '约这条线路') and visible(F, '现在不付钱') and visible(F, '出发前不要给不认识的人私下转账'), '点「约单」：先弹一层说明（进群、不付钱、别私下转账）')
                F.wait_for_timeout(400)
                shot(F, 'trip-web-9-order-sheet.png')
                F.locator('[data-act="order-confirm"]').click()
                F.wait_for_url('**/#/chatroom/**', timeout=10000)
                gname = '川西环线 7 天'
                ok(visible(F, '（2）') and '团' in F.locator('.navbar .title').inner_text(), '点「约单并进群」：直接进了线路群的聊天页（2 人）', F.locator('.navbar .title').inner_text())
                pin = F.locator('[data-info="trip-pin"]')
                ok(wait_text(F, '[data-info="trip-pin"]', gname) and '看线路' in pin.inner_text() and '¥3,980' in pin.inner_text(), '群聊页顶上钉着这条线路的卡片', pin.inner_text() if pin.count() else '')
                W.send(F, '【自测】约单进来的 ' + stamp)
                ok(visible(F, '【自测】约单进来的 ' + stamp), '在线路群里能发消息')
                F.wait_for_timeout(2500)
                ok('发送中' not in text_of(F, 'body'), '那条消息发出去了（不再是「发送中」）')
                shot(F, 'trip-web-10-group.png')
                ok(wait_text(M, '.tp-wb', '1 人约过单'), '领队正停在这条线路的管理页：不刷新，「约单的人」变成 1 人')
                depth = F.evaluate('history.state && history.state.idx')
                pin.click()
                F.locator('[data-act="trip-btn"]').wait_for(state='visible', timeout=8000)
                ok(F.locator('[data-act="trip-btn"]').inner_text() == '进入群聊' and '1 人已约单' in text_of(F) and F.locator('.tp-faces .hn-meav').count() == 1, '点卡片回线路详情：按钮变成「进入群聊」，1 人已约单，有她的头像', text_of(F))
                F.locator('[data-act="trip-btn"]').click()
                F.wait_for_url('**/#/chatroom/**', timeout=8000)
                ok(visible(F, '【自测】约单进来的 ' + stamp) and F.evaluate('history.state && history.state.idx') == depth,
                   '在这一页点「进入群聊」：退回刚才那一页群聊（没有再叠一层）', (depth, F.evaluate('history.state && history.state.idx')))
                F.locator('[data-info="trip-pin"]').click()
                F.locator('[data-act="trip-btn"]').wait_for(state='visible', timeout=8000)

                print('【7 领队管这条线路：名额、约单的人、进群】')
                M.locator('[data-act="plus"]').click()
                ok(wait_text(M, '[data-info="confirmed"]', '1') and visible(M, '还剩 2 位'), '领队点「＋」：已定 1 人，页面上显示「还剩 2 位」')
                ok(wait_text(F, '[data-info="orders"]', '还剩 2 位'), '女正停在线路详情上：不刷新就变成「还剩 2 位」')
                M.locator('[data-act="quota"]').click()
                M.locator('.hn-dialog input').fill('0')
                ok(M.locator('.hn-dialog').get_by_role('button', name='保存').is_disabled(), '改总名额：填 0 保存按钮是灰的')
                M.locator('.hn-dialog input').fill('5')
                M.locator('.hn-dialog').get_by_role('button', name='保存').click()
                ok(visible(M, '总名额 5') and wait_text(F, '[data-info="orders"]', '名额 5，还剩 4 位'), '改成 5：两边都变成名额 5、还剩 4 位')
                shot(M, 'trip-web-11-manage.png')
                M.locator('[data-act="orders"]').click()
                ok(visible(M, '约单的人（1）') and M.locator('[data-order="%s"]' % fid).count() == 1 and fname in M.locator('[data-order]').first.inner_text(), '「约单的人」：1 个，是她', text_of(M))
                M.wait_for_timeout(2500)
                shot(M, 'trip-web-12-orders.png')
                M.go_back()
                M.locator('[data-act="group"]').click()
                M.wait_for_url('**/#/chatroom/**', timeout=10000)
                ok(visible(M, '【自测】约单进来的 ' + stamp) and wait_text(M, '[data-info="trip-pin"]', '看线路'), '「进线路群」：进了群聊页，看得到她发的那条，顶上也钉着线路卡', text_of(M, 'body'))
                M.go_back()

                print('【8 领队自己看到的、上架后改内容】')
                M.locator('[data-act="edit"]').click()
                M.locator('[data-f="price"]').wait_for(state='visible', timeout=8000)
                M.locator('[data-f="price"]').fill('4200')
                M.locator('[data-act="submit"]').click()
                ok(visible(M, '审核通过之前，别人看到的还是原来那一版'), '上架以后改价格：提交了，说明别人看到的还是原来那一版')
                M.wait_for_url('**/#/leader', timeout=8000)
                ok(wait_text(M, '[data-mine]', '改动审核中') and M.locator('[data-mine] .tp-st').first.inner_text() == '招募中', '领队后台：还是「招募中」，后面多了「改动审核中」')
                ok('¥3,980' in text_of(F), '女看到的价格还是 3980')
                r = admin.call('POST', '/trips/%s/review' % tid, {'pass': True})
                ok(r.get('pass') is True and wait_text(F, '.tp-price', '¥4,200'), '（后台）通过：女的详情页不刷新，价格变成 ¥4,200', r)
                shot(M, 'trip-web-13-leader-home.png')
                go(M, '#/hall')
                ok(wait_text(M, '[data-act="my-leader"]', '我自己') and M.locator('[data-trip]').count() == 1, '领队自己打开大厅的旅行：最上面是自己（「我自己」），下面是自己的线路')
                M.locator('[data-act="my-leader"]').click()
                ok(visible(M, '我的线路') and M.locator('[data-act="chat"]').count() == 0 and M.locator('.tp-lhero .tp-gbtn').count() == 2, '自己的领队页：写「我的线路」，没有「发消息」，右上角多一个分享')
                M.locator('[data-trip]').first.click()
                M.locator('[data-act="trip-btn"]').wait_for(state='visible', timeout=8000)
                ok(M.locator('[data-act="trip-btn"]').inner_text() == '进入群聊' and visible(M, '管理这条线路', 3000) and visible(M, '这是你的线路', 3000), '自己的线路详情：按钮是「进入群聊」，多一行「管理这条线路」',
                   (M.locator('[data-act="trip-btn"]').get_attribute('data-btn'), M.locator('.tp-dockb').inner_text(), text_of(M)[-160:], M.url))
                box = M.locator('.tp-dockb .hn-grow').bounding_box()
                ok(box and box['width'] > 120, '底部那一条：左边两行说明没有被按钮挤扁（宽 %d）' % (box['width'] if box else 0))
                shot(M, 'trip-web-15-detail-owner.png')

                print('【9 发布线路：和 AI 聊（花一点牵豆）】')
                go(M, '#/leader/publish')
                M.locator('.hn-ibar input').fill('阿拉善穿沙 5 天，%d 月 %d 号银川出发，2680 起，收 8 个人。含车和住宿，不含餐。第一天银川到左旗，后面四天在沙漠里。'
                                                % (int(L.day(20)[5:7]), int(L.day(20)[8:10])))
                M.locator('[data-act="say"]').click()
                ok(visible(M, '正在认…', 3000), '说了一句：先出一个「正在认…」')
                try:
                    # 第 1 个气泡是开场白；等第 2 个出来、并且不再是「正在认…」
                    M.wait_for_function("() => { const b = [...document.querySelectorAll('.hn-bb.ai')]; return b.length >= 2 && !b.some(x => x.innerText.includes('正在认')); }", timeout=60000)
                    said = M.locator('.hn-bb.ai').nth(1).inner_text()
                except Exception:
                    said = ''
                ok(said and '出了点问题' not in said, 'AI 回了一句：%s' % said, text_of(M))
                ok(M.locator('.hn-bb.me').count() == 1 and '阿拉善' in M.locator('.hn-bb.me').inner_text(), '自己说的那句在右边')
                M.wait_for_timeout(500)
                shot(M, 'trip-web-14-publish-ai.png')
                if M.locator('[data-act="to-form"]').count():
                    M.locator('[data-act="to-form"]').click()
                v = {k: M.locator('[data-f="%s"]' % k).input_value() for k in ('title', 'startDate', 'days', 'gatherPlace', 'price', 'quota')}
                ok(v['days'] == '5' and v['price'] == '2680' and v['quota'] == '8' and '银川' in v['gatherPlace'] and v['startDate'] == L.day(20) and v['title'],
                   '切到「自己填」：AI 认出来的都带过来了（5 天、2680、8 人、银川、出发日期、标题）', v)
                ok(M.locator('.tp-up.none').count() == 1, '还没选视频，那一块是空的（这条不提交）')

                print('【10 下架、取消领队】')
                go(M, '#/leader/trip/%s' % tid)
                M.locator('[data-act="off"]').wait_for(state='visible', timeout=8000)
                go(F, '#/hall')
                F.locator('[data-trip="%s"]' % tid).wait_for(state='visible', timeout=8000)
                ok('¥4,200' in F.locator('[data-trip]').first.inner_text() and '1 人已约单' in F.locator('[data-trip]').first.inner_text(), '女回到大厅：线路卡上是新价格、1 人已约单')
                M.locator('[data-act="off"]').click()
                ok(visible(M, '下架这条线路？') and visible(M, '已经有 1 人约单'), '领队点「下架这条线路」：先问一句，写着已经有 1 人约单')
                M.locator('.hn-dialog').get_by_role('button', name='下架').click()
                ok(wait_text(M, '.tp-st', '已下架') and M.locator('[data-act="off"]').count() == 0 and M.locator('[data-act="edit"]').count() == 0, '下架了：状态变成「已下架」，不能再改、再下架')
                try:
                    F.locator('[data-trip]').first.wait_for(state='detached', timeout=8000)
                except Exception:
                    pass
                ok(F.locator('[data-trip]').count() == 0 and F.locator('[data-act="leaderboard"]').count() == 0 and visible(F, '现在没有正在招募的线路'), '女的大厅不刷新：线路卡没了，排行榜入口也没了（榜上没人了）')
                go(F, '#/chat')
                row = F.locator('.cl-row', has_text='川西环线 %s 团' % L.day(10)[5:]).first
                row.wait_for(state='visible', timeout=8000)
                ok('旅行' in row.inner_text(), '女的消息列表里这个线路群还在，带着「旅行」小标签', row.inner_text())
                row.click()
                ok(visible(F, '这个群已解散') and visible(F, '【自测】约单进来的 ' + stamp), '线路群解散了，之前的聊天记录还能看')
                F.wait_for_timeout(1200)
                ok(F.locator('[data-info="trip-pin"]').count() == 0, '线路下架了，群聊页顶上不再钉线路卡')
                go(M, '#/me')
                ok(visible(M, '领队后台'), '领队回到「我的」页：有「领队后台」')
                r = admin.call('POST', '/users/%s/leader' % mid, {'leader': False})
                ok(r.get('isLeader') is False, '（后台）取消领队', r)
                try:
                    M.get_by_text('领队后台', exact=True).wait_for(state='detached', timeout=8000)
                except Exception:
                    pass
                ok(M.get_by_text('领队后台', exact=True).count() == 0, '他的「我的」页不刷新，「领队后台」那一行没了')
                go(M, '#/leader')
                ok(visible(M, '领队'), '这时候硬打开领队后台的网址：进不去，只有一句提示：%s' % M.locator('.tp-empty').first.inner_text())
                ok(not errors, '两个页面全程没有脚本报错', errors)
            finally:
                b.close()
    finally:
        print('【收尾：全部还原】')
        T.fails = 0
        asyncio.run(L.cleanup(ft, mt, mid, msid))
        admin.close()
    bad = W.fails + T.fails
    print('有 %d 条不对' % bad if bad else '全部通过')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
