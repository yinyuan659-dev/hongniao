# -*- coding: utf-8 -*-
"""
iOS 的群聊解析静态检查（Windows 上没有 Swift，编译不了、跑不了，只能这样对一遍）。

把 Swift 源码里这些 Codable 结构的字段和类型读出来，按 Swift 自动生成的 Decodable 的规则
（不可空的字段：服务器必须给、不能是 null、类型要对；可空的字段：可以没有 / 是 null，给了类型就要对），
去对 android/app/src/test/resources/group_fixture.json 里服务器的真实返回（deploy/group_app_fixture.py 取的）。

解析失败在 iOS 上的后果很重而且不报错：消息列表用的是 try?，一行认不出来整个列表就是空的。
这个检查挡得住「字段名写错、类型不对、该可空的没写可空」；挡不住别的（界面、逻辑、能不能编译）。

用法（在仓库根目录）：python deploy/ios_decode_check.py
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'ios', 'Hongniang', 'Hongniang')
FIXTURE = os.path.join(ROOT, 'android', 'app', 'src', 'test', 'resources', 'group_fixture.json')
FILES = ['ChatViews.swift', 'GroupViews.swift', 'WsClient.swift', 'MsgActions.swift', 'ChatSearchViews.swift']

PROP = re.compile(r'^\s*(?:private\s+)?(?:var|let)\s+(\w+)\s*:\s*([\w\[\]\.]+)(\?)?\s*(=.*)?$')


def structs():
    """{结构名: [(字段, 类型, 可空)]}，只收声明里带 Codable / Decodable 的"""
    out = {}
    for f in FILES:
        lines = io.open(os.path.join(SRC, f), encoding='utf-8').read().split('\n')
        i = 0
        while i < len(lines):
            m = re.match(r'^\s*(?:private\s+|fileprivate\s+)?struct\s+(\w+)\s*:\s*([^{]*)\{\s*$', lines[i])
            if not m or not re.search(r'\b(Codable|Decodable)\b', m.group(2)):
                i += 1
                continue
            name, props, depth = m.group(1), [], 1
            i += 1
            while i < len(lines) and depth > 0:
                line = lines[i]
                code = line.split('//')[0]
                # 只认结构体最外面一层、不带花括号的存储属性（带花括号的是算出来的属性，不参与解析）
                if depth == 1 and '{' not in code and 'static' not in code:
                    p = PROP.match(code)
                    if p:
                        props.append((p.group(1), p.group(2), bool(p.group(3))))
                depth += code.count('{') - code.count('}')
                i += 1
            out[name] = props
    return out


S = structs()
errors = []


def check(value, typ, optional, path):
    if value is None:
        if not optional:
            errors.append('%s：服务器给的是 null / 没给，Swift 里写的是不可空的 %s' % (path, typ))
        return
    if typ.startswith('[') and typ.endswith(']'):
        if not isinstance(value, list):
            errors.append('%s：应该是数组，服务器给的是 %s' % (path, type(value).__name__))
            return
        for k, v in enumerate(value):
            check(v, typ[1:-1], False, '%s[%d]' % (path, k))
        return
    if typ == 'String':
        ok = isinstance(value, str)
    elif typ == 'Int':
        ok = isinstance(value, int) and not isinstance(value, bool)
    elif typ == 'Bool':
        ok = isinstance(value, bool)
    elif typ in ('Double', 'CGFloat'):
        ok = isinstance(value, (int, float)) and not isinstance(value, bool)
    elif typ in S:
        if not isinstance(value, dict):
            errors.append('%s：应该是对象 %s，服务器给的是 %s' % (path, typ, type(value).__name__))
            return
        for name, t, opt in S[typ]:
            check(value.get(name), t, opt, '%s.%s' % (path, name))
        return
    else:
        errors.append('%s：检查脚本不认识类型 %s' % (path, typ))
        return
    if not ok:
        errors.append('%s：Swift 里是 %s，服务器给的是 %s（%r）' % (path, typ, type(value).__name__, value))


def main():
    fx = json.load(io.open(FIXTURE, encoding='utf-8'))
    fr = fx['frames']
    need = ['ConversationItem', 'LastMsg', 'PeerBrief', 'ConvMatch', 'GroupInfo', 'GroupMemberView', 'GroupEvent', 'MessagePayload',
            'ReplyPreview', 'MsgReaction', 'MsgItem', 'PinItem', 'SearchResp', 'SearchMsgHit', 'SearchUserHit', 'GroupOkResp']
    missing = [n for n in need if n not in S]
    if missing:
        print('Swift 源码里没找到这些结构：%s' % '、'.join(missing))
        sys.exit(1)
    cases = []
    for k in ('convsMember', 'convsOwner', 'convsMemberMuted', 'convsKicked', 'convsDissolved'):
        cases.append((k, fx[k], '[ConversationItem]'))
    for k in ('viewMember', 'viewOwner', 'viewKicked', 'viewDissolved', 'update'):
        cases.append((k, fx[k], 'GroupInfo'))
    for k in ('create', 'join', 'info', 'kick', 'dissolved'):
        cases.append(('frames.' + k, fr[k]['data'], 'GroupEvent'))
    for k in ('msg', 'sysJoin', 'msgReply'):
        cases.append(('frames.' + k, fr[k]['data'], 'MessagePayload'))
    cases.append(('messagesMember', fx['messagesMember'], '[MsgItem]'))
    cases.append(('pins', fx['pins'], '[PinItem]'))
    cases.append(('search', fx['search'], 'SearchResp'))
    cases.append(('mute', fx['mute'], 'GroupOkResp'))
    for path, value, typ in cases:
        before = len(errors)
        check(value, typ, False, path)
        print(('  ✓ ' if len(errors) == before else '  ✗ ') + '%s 按 %s 解析' % (path, typ))
    # 群那一行、群资料里用到的字段，Swift 结构里有没有（防止字段名写错：可空字段名字写错了不会报解析失败，只会一直是 nil）
    used = {
        'GroupInfo': set(fx['viewMember'].keys()),
        'GroupMemberView': set(fx['viewMember']['members'][0].keys()),
        'GroupEvent': set(fr['join']['data'].keys()),
        'LastMsg': set(fx['convsMember'][0]['lastMsg'].keys()),
    }
    for name, keys in used.items():
        have = set(p[0] for p in S[name])
        lost = sorted(keys - have)
        extra = sorted(have - keys)
        ok = not lost
        if not ok:
            errors.append('%s：服务器给了、Swift 里没有的字段：%s' % (name, '、'.join(lost)))
        print(('  ✓ ' if ok else '  ✗ ') + '%s 的字段名和服务器对得上' % name + (('（Swift 里多写的、服务器这次没给的：%s）' % '、'.join(extra)) if extra else ''))
    for e in errors:
        print('    ' + e)
    print('有 %d 处对不上' % len(errors) if errors else '全部对得上')
    sys.exit(1 if errors else 0)


if __name__ == '__main__':
    main()
