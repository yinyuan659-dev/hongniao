# 把几张截图横着拼成一张（自己检查用）：python sheet.py 输出名 图1 图2 ...（都在 shots/ 下，不带 .png）
import os, sys
from PIL import Image

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')
ims = [Image.open(os.path.join(HERE, n + '.png')).convert('RGB') for n in sys.argv[2:]]
h = 900
ims = [im.resize((round(im.width * h / im.height), h), Image.NEAREST) for im in ims]
out = Image.new('RGB', (sum(im.width for im in ims) + 8 * (len(ims) - 1), h), (20, 16, 26))
x = 0
for im in ims:
    out.paste(im, (x, 0)); x += im.width + 8
out.save(os.path.join(HERE, sys.argv[1] + '.png'))
print(sys.argv[1], out.size)
