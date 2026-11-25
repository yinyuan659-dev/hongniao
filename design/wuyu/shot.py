# 给「相亲物语」原型截图（样稿里的游戏画面都是用它截出来的真实画面），并数一数每张图上有多少个头像。
# 用法（在 design/wuyu 下）：
#   python shot.py            按下面 SHOTS 表把样稿用到的图全部重截一遍，数字写进 shots/counts.json
#   python shot.py 名字 "网址参数" [宽] [高]     只截一张
# 需要本机 Edge 和 Python 的 playwright（进度文档 §7）。
import json, os, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'shots')
BASE = 'file:///' + HERE.replace('\\', '/') + '/index.html'
FIX = 'ui=0&freeze=1&hint=0'

# 名字 -> (参数, 宽, 高)。362×690 = 样稿手机框里去掉状态栏和标题栏以后的游戏区域；360×640 = 小屏手机整屏；780×360 = 横屏
SHOTS = {
    'world': ('z=-16&bub=0&' + FIX, 362, 690),                    # 樱花道：一进来的样子
    'cover': ('z=-16&bub=0&hud=0&' + FIX, 362, 690),              # 不带左上右上两个按钮，给大厅的入口卡片当封面
    'near': ('z=-16&bub=1&' + FIX, 362, 690),                     # 站住：离你最近的人冒出气泡
    'walk-tap': ('z=-12&tx=1.3&tz=-22&bub=0&' + FIX, 362, 690),   # 点路面：出现一个圈，人走过去
    'walk-joy': ('z=-16&joy=1&bub=0&' + FIX, 362, 690),           # 按住拖动：摇杆
    'menu': ('z=-16&menu=1&bub=0&' + FIX, 362, 690),              # 左上角点开：选场景
    'ginkgo': ('scene=ginkgo&z=-12&bub=0&' + FIX, 362, 690),
    'pine': ('scene=pine&z=-10&bub=0&' + FIX, 362, 690),
    'lantern': ('scene=lantern&z=-12&bub=0&' + FIX, 362, 690),
    'rain': ('z=-16&w=rain&bub=0&' + FIX, 362, 690),
    'dusk': ('z=-16&t=dusk&bub=0&' + FIX, 362, 690),
    'night': ('z=-16&t=night&bub=0&' + FIX, 362, 690),
    'end': ('z=-70&bub=0&' + FIX, 362, 690),                      # 走到路的尽头
    'land': ('z=-16&bub=0&' + FIX, 780, 360),                     # 横屏对比
    'world-360': ('z=-16&bub=0&' + FIX, 360, 640),                # 小屏手机整屏
    'near-360': ('z=-16&bub=1&' + FIX, 360, 640),
    'land-640': ('z=-16&bub=0&' + FIX, 640, 360),
}


def shoot(page, name, query, w, h):
    page.set_viewport_size({'width': w, 'height': h})
    page.goto(BASE + '?' + query)
    page.wait_for_selector('body.ready', timeout=60000)
    page.wait_for_timeout(700)
    path = os.path.join(OUT, name + '.png')
    page.screenshot(path=path)
    c = page.evaluate('() => window.__wuyu.count()')
    print(f"{name:<12} {w}x{h}  头像 {c['onScreen']:>3} 个，看得清 {c['clear']:>3} 个，场景里共 {c['total']} 人  ({os.path.getsize(path)} 字节)")
    return c


def main():
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(channel='msedge', headless=True, args=[
            '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
            '--allow-file-access-from-files', '--no-proxy-server'])
        ctx = b.new_context(viewport={'width': 362, 'height': 690}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on('console', lambda m: print('[console]', m.type, m.text[:400]) if m.type == 'error' else None)
        page.on('pageerror', lambda e: print('[pageerror]', str(e)[:600]))
        if len(sys.argv) < 2:
            counts = {k: shoot(page, k, q, w, h) for k, (q, w, h) in SHOTS.items()}
            with open(os.path.join(OUT, 'counts.json'), 'w', encoding='utf-8') as f:
                json.dump(counts, f, ensure_ascii=False, indent=1)
        else:
            q = sys.argv[2] if len(sys.argv) > 2 else FIX
            shoot(page, sys.argv[1], q, int(sys.argv[3]) if len(sys.argv) > 3 else 362, int(sys.argv[4]) if len(sys.argv) > 4 else 690)
        b.close()


if __name__ == '__main__':
    main()
