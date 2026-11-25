# -*- coding: utf-8 -*-
"""
检查三端的翻译文件和网页静态页里，还有没有提到已经删掉的功能（钱包、积分、礼物、群、频道、语音房、约单…）。
这些字样留在安装包里，应用商店审核会认为功能还在、只是藏起来了。出包前跑一遍，应该是 0 条命中。

用法（在仓库根目录）：python deploy/i18n_audit.py
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = {
    'web': 'web/src/i18n/locales/%s.json',
    'android': 'android/app/src/main/assets/i18n/%s.json',
    'ios': 'ios/Hongniang/Hongniang/i18n/i18n_%s.json',
}
ZH = re.compile(r'钱包|转账|提现|积分|礼物|群聊|群码|频道|机器人|语音房|搭子|陪玩|地陪|树洞|USDC|链上|区块链|助记词|私钥|金币|打赏|约单|仲裁|小游戏|游戏')
EN = re.compile(r'wallet|withdraw|\bpoints\b|gift|group chat|group code|channel|\bbots?\b|voice room|buddy|treehole|USDC|blockchain|mnemonic|private key|\bcoins?\b|tipping|\bgames?\b', re.I)
# 协议正文里会正常出现「请勿向对方转账」「彩礼（betrothal gifts）」这类话，单独用一组不含这两个词的规则查
ZH_DOC = re.compile(r'钱包|提现|积分|礼物|群聊|频道|机器人|语音房|搭子|陪玩|地陪|树洞|USDC|链上|区块链|助记词|私钥|金币|打赏|约单|仲裁|游戏')
EN_DOC = re.compile(r'wallet|withdraw|\bpoints\b|(?<!betrothal )gifts?\b|group chat|\bbots?\b|voice room|treehole|USDC|blockchain|mnemonic|private key|\bcoins?\b|tipping|\bgames?\b', re.I)
IS_DOC = re.compile(r'^agreement\.')

bad = 0
for platform, pattern in FILES.items():
    for lang, rx, rx_doc in (('zh', ZH, ZH_DOC), ('en', EN, EN_DOC)):
        path = pattern % lang
        data = json.loads(io.open(os.path.join(ROOT, path), encoding='utf-8').read())
        # 只看给用户看的文字（值），不看条目的名字
        hits = [(k, str(v).replace('\n', ' / ')[:70]) for k, v in data.items() if (rx_doc if IS_DOC.match(k) else rx).search(str(v))]
        bad += len(hits)
        print('%-8s %s  %d 条，命中 %d' % (platform, lang, len(data), len(hits)))
        for k, v in hits:
            print('    %s = %s' % (k, v))

for name in ('terms.html', 'privacy.html', 'support.html'):
    text = io.open(os.path.join(ROOT, 'web', 'public', name), encoding='utf-8').read()
    hits = sorted(set(ZH_DOC.findall(text)) | {m.lower() for m in EN_DOC.findall(text)})
    bad += len(hits)
    print('web/public/%-13s 命中 %d %s' % (name, len(hits), ' '.join(hits)))

print('没有发现已删功能的字样' if not bad else '共 %d 处要看' % bad)
sys.exit(1 if bad else 0)
