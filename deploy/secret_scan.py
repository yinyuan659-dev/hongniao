# -*- coding: utf-8 -*-
"""
提交 / 推送之前扫一遍「已暂存、将要提交」的内容里有没有密钥。仓库是公开的，推上去就收不回来。

用法（在仓库根目录）：
    git add -A
    python deploy/secret_scan.py        退出码 0 = 没发现，1 = 有命中（看输出，逐条确认后再提交）

查三样：
  1. 两份凭据文档（都不进 Git）里的密钥值有没有出现在将要提交的文件里：服务器密码、阿里云 AccessKey、
     安卓签名密码，以及文档里所有「长得像密钥」的串（够长、同时有字母和数字、不是网址 / 路径 / 文件名）。
  2. 常见密钥的样子：阿里云 AccessKey、sk- 开头的 Key、私钥、登录令牌、测试号的设备号。
  3. 不该入库的文件：凭据文档、签名文件、苹果证书和私钥、.env、进度文档和开发文档、带设备号的测试文件。

只打印文件名和命中的是哪一类，不打印密钥本身。
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRED = os.path.join(ROOT, '服务器凭据-勿提交.md')
ENT = os.path.join(ROOT, '企业资料与凭据-勿提交.md')


def git(*args):
    return subprocess.run(['git', '-C', ROOT, *args], capture_output=True).stdout


def read(path):
    return open(path, encoding='utf-8').read() if os.path.exists(path) else ''


def collect_secrets():
    secrets = {}   # 值 -> 是哪一类
    cred, ent = read(CRED), read(ENT)
    # 服务器密码：凭据文档里第 6 个表格行的第 2 格
    rows = [l for l in cred.splitlines() if l.lstrip().startswith('|')]
    if len(rows) > 5:
        secrets[rows[5].split('|')[2].strip().strip('`')] = '服务器密码'
    for name in ('KYC_ALIYUN_ACCESS_KEY_ID', 'KYC_ALIYUN_ACCESS_KEY_SECRET', 'ANDROID_KEYSTORE_PASSWORD'):
        m = re.search(r'(?m)^%s=(\S+)' % name, ent)
        if m:
            secrets[m.group(1)] = name
    # 网址、仓库里的路径、文件名、IP、包名都不是密钥
    public = re.compile(r'^(https?:|/|[\d.]+$|(design|deploy|android|ios|web|houduan)/)|\.(md|yml|json|sh|py|jks|com|git|apk|png|cer|p8|key)$|^(120\.55\.59\.158|com\.wh\.hongniang)$', re.I)
    for label, text in (('服务器凭据文档里的串', cred), ('企业资料文档里的串', ent)):
        for tok in set(re.findall(r'[A-Za-z0-9_\-+/=]{16,}', text)):
            # 公钥、证书指纹是公开信息（装了 App 的人都能读出来），纯十六进制的长串不算
            if public.search(tok) or re.fullmatch(r'[0-9A-F]{32,}|\d{100,}', tok):
                continue
            if re.search(r'[A-Za-z]', tok) and re.search(r'\d', tok):
                secrets.setdefault(tok, label)
    secrets.pop('', None)
    return secrets


PATTERNS = {
    '阿里云 AccessKey 的样子': re.compile(r'LTAI[0-9A-Za-z]{12,}'),
    'sk- 开头的 Key': re.compile(r'\bsk-[A-Za-z0-9]{20,}'),
    '私钥': re.compile(r'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY'),
    '登录令牌': re.compile(r'eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{10,}'),
    '测试号的设备号': re.compile(r'web_hntest_[a-z]+_\d'),
}
FORBIDDEN = re.compile(
    r'凭据|\.jks$|\.keystore$|\.p8$|\.p12$|\.pem$|\.key$|\.cer$|\.certSigningRequest$|\.mobileprovision$|(^|/)\.env$'
    r'|^ios/signing/|AI进度文档|开发文档|deploy/dev_[fm]\.json|deploy/m1_(test|final)\.sh')


def main():
    secrets = collect_secrets()
    if not secrets:
        print('没读到凭据文档，只能按样子查')
    files = [f for f in git('diff', '--cached', '--name-only', '-z').decode('utf-8').split('\0') if f]
    hits = 0
    for f in files:
        if FORBIDDEN.search(f):
            hits += 1
            print('不该入库的文件：', f)
        blob = git('show', ':' + f)
        if not blob:
            continue                      # 这次是删除
        text = blob.decode('utf-8', errors='ignore')
        for val, label in secrets.items():
            if val in text:
                hits += 1
                print('命中「%s」，在 %s' % (label, f))
        for label, pat in PATTERNS.items():
            if pat.search(text):
                hits += 1
                print('命中「%s」，在 %s' % (label, f))
    print('扫了 %d 个将要提交的文件，对照 %d 个密钥值和 %d 类样子，命中 %d 处' % (len(files), len(secrets), len(PATTERNS), hits))
    sys.exit(1 if hits else 0)


if __name__ == '__main__':
    main()
