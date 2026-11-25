# -*- coding: utf-8 -*-
"""
清理三端翻译文件里已经没人用的条目（原项目删掉的功能留下来的文案：链钱包、群聊、频道、礼物、语音房…）。

为什么要清：这些文字会打进安装包。安装包里的东西应该和 App 实际有的功能一致：
包里有一大堆文案、App 里却找不到对应的功能，应用商店审核会认为功能还在、只是没露出来。

怎么判断「有人用」（宁可多留，不误删）：
  1. 这条的名字在源码里作为一个完整的字符串出现过（不管是不是直接传给 t()）。
  2. 源码里有拼出来的名字：字符串开头是某个前缀，后面接变量（"prefix." + x、"prefix.$x"、`prefix.${x}`、"prefix.\\(x)"），
     那么所有以这个前缀开头的条目都留着。
其它的删掉。两种语言的文件按同一份「要留的名字」处理，保持一致。

用法（在仓库根目录）：
  python deploy/i18n_prune.py            只报告，不改文件
  python deploy/i18n_prune.py --apply    真的改（改之前先看一眼报告）
"""
import io
import json
import os
import re
import sys
from collections import Counter, OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPLY = '--apply' in sys.argv

PLATFORMS = {
    'web': {
        'src': 'web/src', 'ext': ('.ts', '.tsx'), 'skip': ('web/src/i18n/locales',),
        'files': ['web/src/i18n/locales/zh.json', 'web/src/i18n/locales/en.json'],
    },
    'android': {
        'src': 'android/app/src/main/java', 'ext': ('.kt',), 'skip': (),
        'files': ['android/app/src/main/assets/i18n/zh.json', 'android/app/src/main/assets/i18n/en.json'],
    },
    'ios': {
        'src': 'ios/PeiwanIos/PeiwanIos', 'ext': ('.swift',), 'skip': (),
        'files': ['ios/PeiwanIos/PeiwanIos/i18n/i18n_zh.json', 'ios/PeiwanIos/PeiwanIos/i18n/i18n_en.json'],
    },
}

# 完整的字符串：引号里只有名字会用到的字符
LITERAL = re.compile(r'''["'`]([A-Za-z0-9_][A-Za-z0-9_.\-]*)["'`]''')
# 拼出来的名字的开头：引号 + 前缀 + （变量插值 | 以点结尾后收引号 | 收引号后接加号）
DYNAMIC = re.compile(r'''["'`]([A-Za-z0-9_][A-Za-z0-9_.\-]*?)(?:\$\{|\$[A-Za-z_]|\\\(|\.["'`]|["'`]\s*\+)''')
# 提醒人工看一眼的：t( 后面第一个参数不是字符串（名字是变量，可能来自别处）
T_VAR = re.compile(r'''(?<![A-Za-z0-9_.])t\(\s*([^"'`\s)][^,)\n]{0,60})''')


def read_sources(cfg):
    chunks, files = [], 0
    base = os.path.join(ROOT, cfg['src'])
    for d, _, names in os.walk(base):
        rel = os.path.relpath(d, ROOT).replace('\\', '/')
        if any(rel.startswith(s) for s in cfg['skip']):
            continue
        for n in names:
            if n.endswith(cfg['ext']):
                chunks.append(io.open(os.path.join(d, n), encoding='utf-8').read())
                files += 1
    return '\n'.join(chunks), files


def load(path):
    return json.loads(io.open(os.path.join(ROOT, path), encoding='utf-8').read(), object_pairs_hook=OrderedDict)


def dump(path, data):
    # 和原文件一样：两个空格缩进、不转义中文、末尾一个换行
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    io.open(os.path.join(ROOT, path), 'w', encoding='utf-8', newline='\n').write(text)


def main():
    total_removed = 0
    for name, cfg in PLATFORMS.items():
        src, nfiles = read_sources(cfg)
        literals = set(LITERAL.findall(src))
        heads = set()
        for m in DYNAMIC.finditer(src):
            h = m.group(1)
            if m.group(0).endswith(('."', ".'", '.`')):
                h += '.'
            # 太短的前缀（比如一个字母）不算，免得把整份文件都留下
            if len(h) >= 3:
                heads.add(h)
        data = [load(f) for f in cfg['files']]
        keys = list(data[0].keys())
        all_keys = set(keys)
        for d in data[1:]:
            all_keys |= set(d.keys())

        def keep(k):
            if k in literals:
                return True
            return any(k.startswith(h) for h in heads)

        kept = {k for k in all_keys if keep(k)}
        removed = all_keys - kept
        total_removed += len(removed)
        # 真正起了作用的前缀（确实有条目是靠它留下来的）
        live_heads = sorted(h for h in heads if any(k.startswith(h) and k not in literals for k in all_keys))

        print('=== %s：源码 %d 个文件 ===' % (name, nfiles))
        for f, d in zip(cfg['files'], data):
            print('  %s：%d 条 → 留 %d 条，删 %d 条' % (f, len(d), sum(1 for k in d if k in kept), sum(1 for k in d if k not in kept)))
        ns = Counter(k.split('.')[0] for k in removed)
        print('  删得最多的分类：' + '、'.join('%s(%d)' % (a, b) for a, b in ns.most_common(24)))
        print('  靠「拼出来的名字」留下的前缀（%d 个）：%s' % (len(live_heads), ' '.join(live_heads[:60])))
        tv = Counter(x.strip() for x in T_VAR.findall(src))
        print('  t( 后面是变量的写法（人工看一眼，共 %d 种）：%s' % (len(tv), ' | '.join('%s×%d' % (a, b) for a, b in tv.most_common(25))))
        crypto = re.compile(r'chainWallet|^cw\.|USDC|Morpho|助记词|私钥|区块链|链上|钱包|wallet', re.I)
        left = [k for k in kept if crypto.search(k) or any(crypto.search(str(d.get(k, ''))) for d in data)]
        print('  留下的条目里还带钱包 / 区块链字样的（%d 条）：%s' % (len(left), ' '.join(sorted(left)[:20])))

        if APPLY:
            for f, d in zip(cfg['files'], data):
                dump(f, OrderedDict((k, v) for k, v in d.items() if k in kept))
    print('合计删 %d 条。%s' % (total_removed, '已写回文件。' if APPLY else '（只是报告，没有改文件；加 --apply 才改）'))


if __name__ == '__main__':
    main()
