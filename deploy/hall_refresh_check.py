# -*- coding: utf-8 -*-
"""
大厅的两处小改动，只看不改（2026-11-28）：用女测试号（997353）开一个 360 宽、带触摸的手机浏览器，
  1. 大厅「旅行 / 相亲活动」往下拉能刷新；再点一下已经选中的 tab 也能刷新；拉得不够不刷新
  2. 线路详情：返回键在视频上面的顶栏里，视频上不压着我们自己的东西（服务器上得有一条上架的线路才看得了，没有就跳过）
  3. 和领队的单聊（两个测试号之间的那个）：不显示「你们还没有互相喜欢…」，右上角是「看 TA 的领队页」；
     男测试号现在不是领队的话，核对的是照旧的样子。会把这个单聊里没读的消息标成已读，别的不动

  python deploy/hall_refresh_check.py            测本机刚构建的 web/dist（接口连测试服务器）
  python deploy/hall_refresh_check.py live       测已经部署到服务器上的网页

不登录后台、不用服务器密码；不约单、不发消息、不改任何数据。截图存到 design/live/hall-refresh-*.png。
"""
import json, os, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import group_live_test as T  # noqa: E402  （只用 enter、call：用测试号的身份问两个只读的接口）
import group_web_test as W  # noqa: E402  （serve_local、device_id、ok、go、shot、visible；它的 main 不会跑）

ok, go, shot, visible = W.ok, W.go, W.shot, W.visible

# 在滚动容器上模拟手指往下拉 dy 像素：返回松手前那一刻提示条上的字
PULL = """async (dy) => {
  const el = document.querySelector('.page');
  const fire = (type, y) => {
    const t = new Touch({ identifier: 1, target: el, clientX: 180, clientY: y });
    el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
  };
  fire('touchstart', 200);
  for (let i = 1; i <= 10; i++) { fire('touchmove', 200 + dy * i / 10); await new Promise(r => setTimeout(r, 16)); }
  const tip = document.querySelector('.tp-hall .small');
  const seen = tip ? tip.textContent + '|' + Math.round(tip.getBoundingClientRect().height) : 'no-bar';
  fire('touchend', 200 + dy);
  return seen;
}"""

OVER = """() => {
  const v = document.querySelector('video.tp-video').getBoundingClientRect();
  const hit = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left < v.right && r.right > v.left && r.top < v.bottom && r.bottom > v.top; };
  return [...document.querySelectorAll('.hn-nav, .hn-nav *, .tp-gbtn, .tp-box, .tp-dockb')].filter(hit).map(e => String(e.className || e.tagName));
}"""


def main():
    errors, hits = [], []
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True, args=['--no-proxy-server', '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable'])
        try:
            ctx = b.new_context(viewport={'width': 360, 'height': 700}, device_scale_factor=2, is_mobile=True, has_touch=True)
            ctx.add_init_script("localStorage.setItem('pw_device_id', %s)" % json.dumps(W.device_id(os.path.join(HERE, 'dev_f.json'))))
            if not W.LIVE:
                ctx.route('**/*', W.serve_local)
            F = ctx.new_page()
            F.on('pageerror', lambda e: errors.append(str(e)[:200]))
            F.on('request', lambda r: hits.append(r.url) if r.url.endswith('/api/trip/home') else None)
            F.goto(W.SITE + '/')
            F.wait_for_url('**/#/plaza', timeout=20000)
            print('服务器上的网页' if W.LIVE else '本机 web/dist')

            print('【1 大厅：往下拉刷新、再点一下 tab 刷新】')
            go(F, '#/hall')
            F.locator('.tp-tt').wait_for(state='visible', timeout=8000)
            F.wait_for_timeout(1500)
            F.evaluate("sessionStorage.removeItem('hn_hall_tab')")
            if 'on' not in (F.locator('.tp-tt [data-tab="trip"]').get_attribute('class') or ''):
                F.locator('.tp-tt [data-tab="trip"]').click()
                F.wait_for_timeout(1200)
            n0 = len(hits)
            ok(n0 >= 1, '进大厅取了一次旅行首页', n0)
            seen = F.evaluate(PULL, 60)
            F.wait_for_timeout(900)
            ok(seen.startswith('下拉刷新|') and len(hits) == n0, '往下拉一点点（没到位）：提示「下拉刷新」，松手不刷新', (seen, len(hits) - n0))
            ok(F.locator('.tp-hall .small').evaluate('e => e.getBoundingClientRect().height') == 0, '松手后提示条收回去了')
            seen = F.evaluate(PULL, 220)
            ok(seen.startswith('松开刷新|'), '拉够了：提示变成「松开刷新」', seen)
            ok(visible(F, '刷新中…', 2000), '松手：提示「刷新中…」')
            shot(F, 'hall-refresh-1-pulling.png')
            F.wait_for_timeout(1500)
            ok(len(hits) == n0 + 1, '旅行首页重新取了一次', len(hits) - n0)
            ok(F.locator('.tp-hall .small').evaluate('e => e.getBoundingClientRect().height') == 0 and F.locator('[data-info="refresh-failed"]').count() == 0, '刷新完提示条收回去，没有报错')
            F.locator('.tp-tt [data-tab="trip"]').click()
            F.wait_for_timeout(1500)
            ok(len(hits) == n0 + 2, '再点一下已经选中的「旅行」：又取了一次', len(hits) - n0)
            F.locator('.tp-tt [data-tab="event"]').click()
            ok(visible(F, '相亲活动即将开放'), '切到「相亲活动」')
            n1 = len(hits)
            seen = F.evaluate(PULL, 220)
            ok(seen.startswith('松开刷新|') and visible(F, '刷新中…', 2000), '「相亲活动」也能往下拉：提示「松开刷新」→「刷新中…」', seen)
            F.wait_for_timeout(1200)
            ok(F.locator('.tp-hall .small').evaluate('e => e.getBoundingClientRect().height') == 0 and visible(F, '相亲活动即将开放') and len(hits) == n1,
               '刷新完收回去，还在「相亲活动」（它现在没有内容可取）', len(hits) - n1)
            F.locator('.tp-tt [data-tab="trip"]').click()
            F.wait_for_timeout(1200)

            print('【2 线路详情：返回键不压在视频上】')
            card = F.locator('[data-trip]').first
            if card.count() == 0:
                print('  （服务器上现在没有上架的线路，这一段跳过）')
            else:
                card.click()
                F.locator('video.tp-video').wait_for(state='visible', timeout=8000)
                F.wait_for_timeout(800)
                over = F.evaluate(OVER)
                ok(over == [], '视频上没有压着返回键、顶栏、卡片', over)
                back = F.locator('.hn-nav .hn-icbtn')
                v = F.locator('video.tp-video').bounding_box()
                bb = back.bounding_box() if back.count() else None
                ok(bb is not None and bb['y'] + bb['height'] <= v['y'] and F.locator('.tp-gbtn').count() == 0, '返回键在视频上面单独的一条顶栏里', (bb, v))
                ok(v['x'] == 0 and abs(v['width'] - 360) < 1, '视频还是左右顶满', v)
                # 这一页不截图存下来：上面有约了单的人的头像，可能是真用户的，仓库是公开的
                back.click()
                F.wait_for_timeout(800)
                ok(F.locator('.tp-tt').count() == 1 and F.locator('video.tp-video').count() == 0, '点返回键回到大厅')
            print('【3 和领队的单聊：不显示「你们还没有互相喜欢」，右上角是「看 TA 的领队页」】')
            # 两个测试号之间本来就有单聊。男测试号现在是不是领队，按服务器上现在的样子来（这个脚本不改它）
            ft, fid, _, fname = T.enter(os.path.join(HERE, 'dev_f.json'))
            mt, mid, _, mname = T.enter(os.path.join(HERE, 'dev_m.json'))
            m_leader = T.call('/trip/leader/' + mid, ft).get('code') == 0
            mutual = (T.call('/match/relation/' + mid, ft).get('data') or {}).get('state') == 'mutual'
            print('  男测试号现在%s领队；两个测试号%s互相喜欢' % ('是' if m_leader else '不是', '已经' if mutual else '没有'))

            def open_chat(page, peer):
                go(page, '#/chat')
                page.locator('.cl-row:has(.avatar)', has_text=peer).first.click()
                page.locator('.navbar .title', has_text=peer).wait_for(state='visible', timeout=8000)
                page.wait_for_timeout(2000)
                tip = page.locator('.hn-tip', has_text='还没有互相喜欢').count()
                page.locator('.nav-more-btn').click()
                menu = page.locator('.nav-menu').inner_text()
                page.locator('.nav-menu-mask').click()
                return tip, menu

            def pretend_not_mutual(route):
                """把「我和对方的关系」这一个接口的回话改成「谁也没喜欢谁」再交给页面（只骗这个浏览器页面，服务器上什么都没改）"""
                resp = route.fetch()
                body = resp.json()
                if isinstance(body.get('data'), dict):
                    body['data'].update({'state': 'none', 'matchedAt': None})
                route.fulfill(response=resp, json=body)

            tip, menu = open_chat(F, mname)
            if mutual:
                ok(tip == 0 and '看 TA 的画像' in menu and '看 TA 的领队页' not in menu, '两个测试号已经互相喜欢：照相亲的聊天显示（「看 TA 的画像」，没有「还没有互相喜欢」那句）', (tip, menu))
                print('  （下面几条：两个测试号实际上互相喜欢，看不出区别，所以在浏览器里把「关系」接口的回话改成「谁也没喜欢谁」再看；对方是不是领队问的是真服务器）')
                F.route('**/api/match/relation/*', pretend_not_mutual)
                tip, menu = open_chat(F, mname)
            if m_leader:
                ok(tip == 0, '女测试号和领队的单聊：顶上没有「你们还没有互相喜欢…」那句', tip)
                ok('看 TA 的领队页' in menu and '看 TA 的画像' not in menu and '举报' in menu and '不合适，不再联系' in menu, '右上角菜单：「看 TA 的领队页」、举报、不合适不再联系、清空；没有「看 TA 的画像」', menu)
                F.locator('.nav-more-btn').click()
                F.locator('[data-act="peer-leader"]').click()
                ok(visible(F, '认证领队') and visible(F, mname), '点「看 TA 的领队页」：进了他的领队页')
                # 领队那一边
                ctx2 = b.new_context(viewport={'width': 360, 'height': 700}, device_scale_factor=2, is_mobile=True, has_touch=True)
                ctx2.add_init_script("localStorage.setItem('pw_device_id', %s)" % json.dumps(W.device_id(os.path.join(HERE, 'dev_m.json'))))
                if not W.LIVE:
                    ctx2.route('**/*', W.serve_local)
                M = ctx2.new_page()
                M.on('pageerror', lambda e: errors.append(str(e)[:200]))
                if mutual:
                    M.route('**/api/match/relation/*', pretend_not_mutual)
                M.goto(W.SITE + '/')
                M.wait_for_url('**/#/plaza', timeout=20000)
                tip, menu = open_chat(M, fname)
                ok(tip == 0, '领队这一边和她的单聊：也没有那句', tip)
                ok('看 TA 的画像' in menu and '看 TA 的领队页' not in menu, '领队这一边的菜单还是「看 TA 的画像」（对方不是领队）', menu)
            else:
                ok(tip == 1 and '看 TA 的画像' in menu and '看 TA 的领队页' not in menu, '对方不是领队：照旧有那句提示，菜单是「看 TA 的画像」', (tip, menu))
            print('【4 没做真人认证的人：自己的相亲画像上有去认证的入口（「我的」页不另外放）】')
            # 两个测试号都认证过了，先看真数据（不该有入口），再在浏览器里把两个接口的回话改成「没认证」看入口（服务器上什么都没改，也不会真去认证）
            go(F, '#/me')
            F.get_by_text('账号与安全', exact=True).wait_for(state='visible', timeout=8000)
            F.wait_for_timeout(1500)
            ok(F.get_by_text('真人认证', exact=True).count() == 1 and F.get_by_text('未认证', exact=True).count() == 0, '认证过的号：「我的」页只有昵称后面的「真人认证」绿标，没有去认证那一行')
            go(F, '#/card/me')
            F.locator('.hn-hero').wait_for(state='visible', timeout=8000)
            F.wait_for_timeout(1200)
            ok(F.locator('[data-act="go-kyc"]').count() == 0 and visible(F, '真人认证', 3000), '认证过的号：相亲画像上是「真人认证」绿标，没有「去真人认证」')

            def pretend_unverified(route):
                resp = route.fetch()
                body = resp.json()
                if isinstance(body.get('data'), dict):
                    body['data']['realname'] = False
                route.fulfill(response=resp, json=body)

            F.route('**/api/kyc/status', pretend_unverified)
            F.route('**/api/hn/card/me', pretend_unverified)
            F.route('**/api/user/me', pretend_unverified)
            go(F, '#/chat'); go(F, '#/me')
            F.get_by_text('账号与安全', exact=True).wait_for(state='visible', timeout=8000)
            F.wait_for_timeout(1500)
            body = F.locator('body').inner_text()
            sec = body[body.find('账号与安全'):][:120]
            # 「我的」页不放去认证的入口（2026-11-28 22:01 用户说重复了：入口在相亲画像上）。后台要求先认证时那一行「真人认证 · 未完成」还是原来的样子，这里不测
            ok('真人认证' not in sec and '未认证' not in body, '（改成没认证、后台不要求）「我的 → 账号与安全」里没有「真人认证」那一行', sec)
            go(F, '#/card/me')
            chip = F.locator('[data-act="go-kyc"]')
            chip.wait_for(state='visible', timeout=8000)
            ok('去真人认证' in chip.inner_text(), '（改成没认证）自己的相亲画像上，昵称旁边有「去真人认证 ›」')
            shot(F, 'hall-refresh-4-card-unverified.png')
            chip.click()
            F.wait_for_timeout(1200)
            ok('#/kyc?next=%2Fcard%2Fme' in F.url, '点了进真人认证页，认证完回相亲画像（这里不往下做）', F.url)
            F.unroute('**/api/kyc/status'); F.unroute('**/api/hn/card/me'); F.unroute('**/api/user/me')
            ok(not errors, '全程没有脚本报错', errors)
        finally:
            b.close()
    print('有 %d 条不对' % W.fails if W.fails else '全部通过')
    sys.exit(1 if W.fails else 0)


if __name__ == '__main__':
    main()
