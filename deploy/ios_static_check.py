# -*- coding: utf-8 -*-
"""
iOS 的静态自查（Windows 上没有 Xcode、没法编译，改完 Swift 至少跑一下这个）：
  1. 每个 Swift 文件去掉注释和字符串以后，大括号、小括号、方括号是不是配平；
  2. 已经删掉的东西（审核模式、演示账号登录页）有没有残留引用。
配平不等于能编译通过，只能挡住最低级的错误。真正的验证还是要在 Mac 上用 Xcode 编译。

用法（在仓库根目录）：python deploy/ios_static_check.py
"""
import io
import os
import re
import sys

DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'ios', 'Hongniang', 'Hongniang')
BS, DQ = chr(92), chr(34)
# 删掉以后不应该再出现的名字
GONE = ('LoginView', 'reviewMode', 'ReviewMode', 'demo-login', 'review-mode')


def strip(s):
    """去掉注释和字符串（字符串里 \\( … ) 插值的括号也一起去掉）"""
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if s.startswith('//', i):
            j = s.find('\n', i)
            i = n if j < 0 else j
            continue
        if s.startswith('/*', i):
            j = s.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c == DQ:
            if s.startswith(DQ * 3, i):
                j = s.find(DQ * 3, i + 3)
                i = n if j < 0 else j + 3
                continue
            i += 1
            depth = 0
            while i < n:
                if s[i] == BS and i + 1 < n and s[i + 1] == '(':
                    depth += 1
                    i += 2
                    continue
                if s[i] == BS:
                    i += 2
                    continue
                if depth > 0 and s[i] == '(':
                    depth += 1
                elif depth > 0 and s[i] == ')':
                    depth -= 1
                elif depth > 0 and s[i] == DQ:
                    i += 1
                    while i < n and s[i] != DQ:
                        i += 2 if s[i] == BS else 1
                elif depth == 0 and s[i] == DQ:
                    i += 1
                    break
                i += 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)


def main():
    files = sorted(f for f in os.listdir(DIR) if f.endswith('.swift'))
    bad = 0
    code = ''
    for f in files:
        t = strip(io.open(os.path.join(DIR, f), encoding='utf-8').read())
        code += t + '\n'
        b, p, k = t.count('{') - t.count('}'), t.count('(') - t.count(')'), t.count('[') - t.count(']')
        if b or p or k:
            bad += 1
            print('不配平：%s  {}=%d ()=%d []=%d' % (f, b, p, k))
    print('Swift 文件 %d 个，括号%s' % (len(files), '有 %d 个不配平' % bad if bad else '全部配平'))
    for sym in GONE:
        n = len(re.findall(r'(?<![A-Za-z0-9_])' + re.escape(sym) + r'(?![A-Za-z0-9_])', code))
        if n:
            bad += 1
        print('已删的 %-12s 代码里还有 %d 处引用' % (sym, n))
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
