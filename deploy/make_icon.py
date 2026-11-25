# -*- coding: utf-8 -*-
"""
画「一线牵」的应用图标，并输出三端要用的所有尺寸。图标是用代码画的（不是一张图缩放），想调位置、粗细、颜色改这里再跑一遍。

样子（用户 2026-11-25 选的方向 A）：玫红到珊瑚色的渐变底，一根白线绕成一颗心、在心尖打一个结（红线牵缘），
心里一颗四角星，右下角一个白色小胶囊写着「AI」。

要点：
  - 所有内容都画在「正中间一个圆」里面：安卓会把图标裁成圆形 / 圆角方形，iOS 会裁圆角，角上的东西会被裁掉。
  - 安卓自适应图标分两层：背景（渐变）和前景（白色的心、星、胶囊，透明底），画布 432，可见区域是中间的 288。
  - iOS 的图标不能有透明度，输出 RGB。

用法（在仓库根目录，Windows，需要 Pillow）：python deploy/make_icon.py
输出：
  android/app/src/main/res/drawable/ic_launcher_{background,foreground}.png、mipmap-*/ic_launcher{,_round}.png
  ios/PeiwanIos/PeiwanIos/Assets.xcassets/AppIcon.appiconset/AppIcon.png
  web/public/favicon.png、apple-touch-icon.png
  design/icon/app-icon-1024.png、-512.png（备案、应用商店上传用）、app-icon-preview.png（三种裁法的预览）
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 4                      # 先放大 4 倍画，再缩小，边缘才平滑
N = 1024                    # 设计稿的边长，下面的坐标都按 1024 写
ROSE = (255, 61, 99)        # #FF3D63
CORAL = (255, 132, 105)     # #FF8469
WHITE = (255, 255, 255, 255)
FONT = r'C:\Windows\Fonts\arialbd.ttf'

HEART_C = (512, 418)        # 心的中心
HEART_S = 19.5              # 心的大小（心形公式的放大倍数；宽度 = 32 × 这个数）
LINE_W = 46                 # 线的粗细
STAR_C, STAR_R = (676, 372), 66
PILL_C, PILL_W, PILL_H = (739, 778), 204, 118    # 再往右下挪就出了安卓的安全圆（半径 469），会被裁
PILL_FONT = 84


def gradient(size):
    """左上玫红 → 右下珊瑚的斜向渐变"""
    w = h = size
    base = Image.new('RGB', (2, 2))
    px = base.load()
    mid = tuple((a + b) // 2 for a, b in zip(ROSE, CORAL))
    px[0, 0], px[1, 1], px[1, 0], px[0, 1] = ROSE, CORAL, mid, mid
    return base.resize((w, h), Image.BICUBIC)


def stroke(draw, pts, width, fill, k):
    """一条有粗细的线：沿着路径密密地盖圆形的章。点要取得够密（相邻两点不到一个像素），边缘才是光滑的"""
    r = width * k / 2
    for x, y in pts:
        draw.ellipse([x * k - r, y * k - r, x * k + r, y * k + r], fill=fill)


def heart_points(steps=6000):
    cx, cy = HEART_C
    pts = []
    for i in range(steps + 1):
        t = 2 * math.pi * i / steps
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * HEART_S, cy - y * HEART_S))
    return pts


def loop_points(cx, cy, rx, ry, deg, steps=1200):
    """一个斜着的小圈（心尖下面打的结）"""
    a = math.radians(deg)
    pts = []
    for i in range(steps + 1):
        t = 2 * math.pi * i / steps
        x, y = rx * math.cos(t), ry * math.sin(t)
        pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
    return pts


def star_points(cx, cy, r, steps=240):
    """四角星：上下左右四个尖，尖和尖之间往里凹（星形线）"""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        pts.append((cx + r * math.cos(t) ** 3, cy + r * math.sin(t) ** 3))
    return pts


def foreground(size, scale, offset):
    """白色的心、结、星、胶囊，透明底。scale / offset：把 1024 的设计坐标放到 size 画布的哪里"""
    k = SS
    img = Image.new('RGBA', (size * k, size * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def tr(pts):
        return [(offset + x * scale, offset + y * scale) for x, y in pts]

    stroke(d, tr(heart_points()), LINE_W * scale, WHITE, k)
    tip_x, tip_y = HEART_C[0], HEART_C[1] + 17 * HEART_S
    for sign in (-1, 1):
        stroke(d, tr(loop_points(tip_x + sign * 50, tip_y + 44, 46, 30, sign * 38)), LINE_W * 0.62 * scale, WHITE, k)
    d.polygon([(x * k, y * k) for x, y in tr(star_points(STAR_C[0], STAR_C[1], STAR_R))], fill=WHITE)

    # 胶囊 + 「AI」：字用底色（玫红偏珊瑚）写，相当于在白胶囊上镂出字
    px, py = PILL_C
    x0, y0, x1, y1 = [(offset + v * scale) * k for v in (px - PILL_W / 2, py - PILL_H / 2, px + PILL_W / 2, py + PILL_H / 2)]
    d.rounded_rectangle([x0, y0, x1, y1], radius=(y1 - y0) / 2, fill=(255, 255, 255, 240))
    font = ImageFont.truetype(FONT, int(round(PILL_FONT * scale * k)))
    box = d.textbbox((0, 0), 'AI', font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    d.text(((x0 + x1) / 2 - tw / 2 - box[0], (y0 + y1) / 2 - th / 2 - box[1]), 'AI', font=font, fill=(240, 72, 102, 255))
    return img.resize((size, size), Image.LANCZOS)


def full_icon(size=N):
    """整张图标：渐变底 + 前景，方的、不透明"""
    img = gradient(size).convert('RGBA')
    img.alpha_composite(foreground(size, size / N, 0))
    return img


def masked(img, kind):
    """kind：round 圆形 | squircle 圆角方形（半径 22%）"""
    size = img.size[0]
    m = Image.new('L', (size * SS, size * SS), 0)
    d = ImageDraw.Draw(m)
    if kind == 'round':
        d.ellipse([0, 0, size * SS - 1, size * SS - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=int(size * SS * 0.22), fill=255)
    out = img.copy()
    out.putalpha(m.resize((size, size), Image.LANCZOS))
    return out


def save(img, rel, mode=None):
    path = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    (img.convert(mode) if mode else img).save(path, optimize=True)
    print('  %-78s %dx%d %s' % (rel, img.size[0], img.size[1], mode or img.mode))


def main():
    icon = full_icon()
    res = 'android/app/src/main/res'

    print('安卓：')
    save(gradient(432), res + '/drawable/ic_launcher_background.png', 'RGB')
    # 自适应图标的可见区域是画布中间的 2/3（432 里的 288）
    save(foreground(432, 288 / N, 72), res + '/drawable/ic_launcher_foreground.png')
    for name, px in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
        small = icon.resize((px, px), Image.LANCZOS)
        save(masked(small, 'squircle'), '%s/mipmap-%s/ic_launcher.png' % (res, name))
        save(masked(small, 'round'), '%s/mipmap-%s/ic_launcher_round.png' % (res, name))

    print('iOS：')
    save(icon, 'ios/PeiwanIos/PeiwanIos/Assets.xcassets/AppIcon.appiconset/AppIcon.png', 'RGB')

    print('网页：')
    save(masked(icon.resize((192, 192), Image.LANCZOS), 'squircle'), 'web/public/favicon.png')
    save(icon.resize((180, 180), Image.LANCZOS), 'web/public/apple-touch-icon.png', 'RGB')

    print('备案 / 应用商店上传用：')
    save(icon, 'design/icon/app-icon-1024.png', 'RGB')
    save(icon.resize((512, 512), Image.LANCZOS), 'design/icon/app-icon-512.png', 'RGB')

    # 预览：方的、圆角的（iOS）、圆的（安卓），看角上的东西有没有被裁
    prev = Image.new('RGB', (3 * 360 + 4 * 30, 420), (246, 240, 242))
    small = icon.resize((360, 360), Image.LANCZOS)
    for i, im in enumerate((small, masked(small, 'squircle'), masked(small, 'round'))):
        prev.paste(im, (30 + i * 390, 30), im)
    save(prev, 'design/icon/app-icon-preview.png')


if __name__ == '__main__':
    main()
