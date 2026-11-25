# -*- coding: utf-8 -*-
"""
直接在编出来的安卓安装包里找已删功能的痕迹（不是查源码，是查包里真的有什么）：
  1. 包里的翻译文件（assets/i18n/*.json）还剩多少条、有没有钱包 / 区块链字样；
  2. 代码（classes*.dex）和其它文件里有没有钱包 / 区块链 / 审核开关相关的字符串。
应用商店审核看的就是安装包，所以出包以后跑一遍。

用法：python deploy/apk_audit.py [apk 路径]   （不给路径就查 android/app/build/outputs/apk/debug/app-debug.apk）
"""
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APK = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
TEXT = re.compile(r'chainWallet|USDC|Morpho|助记词|私钥|区块链|链上|钱包|mnemonic|blockchain|wallet', re.I)
# 在二进制里找的字节串（dex 里的字符串是 MUTF-8，ASCII 部分和 UTF-8 一样）
BYTES = [b'chainWallet', b'USDC', b'Morpho', b'mnemonic', b'blockchain', b'ethers', b'web3', b'review-mode', b'reviewMode', b'demo-login',
         '助记词'.encode('utf-8'), '区块链'.encode('utf-8'), '钱包'.encode('utf-8')]

bad = 0
with zipfile.ZipFile(APK) as z:
    names = z.namelist()
    print('安装包：%s  %d 字节，%d 个文件' % (os.path.basename(APK), os.path.getsize(APK), len(names)))
    for n in sorted(x for x in names if x.startswith('assets/i18n/') and x.endswith('.json')):
        data = json.loads(z.read(n).decode('utf-8'))
        hits = [k for k, v in data.items() if TEXT.search(k) or TEXT.search(str(v))]
        bad += len(hits)
        print('  %s：%d 条，钱包 / 区块链字样 %d 条 %s' % (n, len(data), len(hits), hits[:5]))
    for n in names:
        if n.startswith('assets/i18n/'):
            continue
        # 只查代码、清单、资源表和 assets 里的文本；图片、so 库不查
        if not (n.endswith('.dex') or n.endswith('.xml') or n.endswith('.arsc') or n.endswith('.json') or n.endswith('.js') or n.endswith('.html')):
            continue
        blob = z.read(n)
        found = [b.decode('utf-8') for b in BYTES if b in blob]
        if found:
            bad += len(found)
            print('  %s 里有：%s' % (n, ' '.join(found)))
print('安装包里没有发现已删功能的痕迹' if not bad else '共 %d 处要看' % bad)
sys.exit(1 if bad else 0)
