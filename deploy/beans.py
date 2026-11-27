# -*- coding: utf-8 -*-
"""
牵豆的后台操作（收款接好之前，测试号、给审核用的号的牵豆都从这里加）。在本机运行，通过 SSH 到服务器上调后台的管理接口；
管理员密码在服务器上从 .env 里取，不打印、不离开服务器。先设好 $env:HN_PW（取法见 AI进度文档.md §7）和 $env:PYTHONIOENCODING='utf-8'。

  python deploy/beans.py add <短号> <数量> [备注]     给一个账号加牵豆（1 牵豆 = 1 元），每次自动用一个新的批次号
  python deploy/beans.py price                       看现在视频见面每分钟多少牵豆
  python deploy/beans.py price <数量>                改价：0～100，最多 4 位小数，0 = 不收费；30 秒内生效，正在打的那一通不受影响

例：python deploy/beans.py add 711405 5 测试      python deploy/beans.py price 0.02
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import remote  # noqa: E402

SERVER_SCRIPT = r'''python3 - <<'EOF'
import json, re, urllib.request
CALLS = __CALLS__
env = open('/opt/hongniang/.env', encoding='utf-8').read()
pw = re.search(r'(?m)^ADMIN_INIT_PASSWORD=(.*)$', env).group(1).strip()
def call(method, path, body=None, token=None):
    req = urllib.request.Request('https://gphnai.com/api/admin' + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})}, method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8', 'replace'))
        except Exception:
            return {'code': e.code, 'msg': 'HTTP %d' % e.code}
tok = (call('POST', '/login', {'username': 'admin', 'password': pw}).get('data') or {}).get('token')
if not tok:
    print('RESULT ' + json.dumps({'error': 'admin login failed'}))
else:
    out = []
    for method, path, body in CALLS:
        r = call(method, path, body, tok)
        out.append(r.get('data') if r.get('code') == 0 else {'error': r.get('msg') or r})
    print('RESULT ' + json.dumps(out, ensure_ascii=False))
EOF
'''


def admin(calls):
    """在服务器上依次调几个管理接口，返回每个的 data（失败的是 {'error': …}）。calls: [(方法, 路径, body 或 None), …]"""
    # repr 出来的是 Python 写法的列表（None / True / False），直接嵌进服务器上那段脚本里
    script = SERVER_SCRIPT.replace('__CALLS__', repr(json.loads(json.dumps(calls))))
    c = remote.connect()
    try:
        stdin, stdout, stderr = c.exec_command('bash -s', timeout=60)
        stdin.write(script)
        stdin.channel.shutdown_write()
        text = stdout.read().decode('utf-8', 'replace') + stderr.read().decode('utf-8', 'replace')
    finally:
        c.close()
    for line in text.splitlines():
        if line.startswith('RESULT '):
            r = json.loads(line[7:])
            if isinstance(r, dict) and r.get('error'):
                raise SystemExit('失败：' + str(r['error']))
            return r
    raise SystemExit('服务器没有返回结果：' + text[-300:])


def add(who, amount, note='平台发放'):
    ref = 'grant-%s-%d' % (who, int(time.time()))
    return admin([('POST', '/ai-wallet/credit', {'who': str(who), 'yuan': float(amount), 'refKey': ref, 'note': note})])[0]


def price(value=None):
    if value is None:
        return admin([('GET', '/call/fee', None)])[0]
    return admin([('PUT', '/call/fee', {'videoPerMin': float(value)})])[0]


def main():
    a = sys.argv[1:]
    if len(a) >= 3 and a[0] == 'add':
        r = add(a[1], a[2], a[3] if len(a) > 3 else '平台发放')
        if r.get('error'):
            raise SystemExit('失败：' + str(r['error']))
        print('给 %s（%s）加了 %s 牵豆，现在有 %s' % (r.get('shortId'), r.get('nickname'), a[2], r.get('balance')))
    elif a and a[0] == 'price':
        r = price(a[1] if len(a) > 1 else None)
        if r.get('error'):
            raise SystemExit('失败：' + str(r['error']))
        print('视频见面现在每分钟 %s 牵豆%s' % (r.get('videoPerMin'), '（不收费）' if float(r.get('videoPerMin') or 0) == 0 else ''))
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
