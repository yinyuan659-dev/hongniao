# 看后台现在的设置：每天推荐几位、每天能喜欢几个、「视频见面要不要互相喜欢」（videoNeedLike）。只读。
# 用法（本机）：python deploy\remote.py run deploy\video_like_status.sh 60
# 管理员密码在服务器上从 .env 里取，不打印。
python3 - <<'EOF'
import json, re, urllib.request
env = open('/opt/hongniang/.env', encoding='utf-8').read()
pw = re.search(r'(?m)^ADMIN_INIT_PASSWORD=(.*)$', env).group(1).strip()
def call(path, body=None, token=None, method=None):
    req = urllib.request.Request('https://gphnai.com/api/admin' + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})},
                                 method=method or ('POST' if body is not None else 'GET'))
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    except urllib.error.HTTPError as e:
        return {'http': e.code, 'msg': e.read().decode('utf-8', 'replace')[:160]}
tok = ((call('/login', {'username': 'admin', 'password': pw}).get('data') or {}).get('token'))
print('admin login:', 'ok' if tok else 'FAILED')
if tok:
    print('match config:', json.dumps(call('/match/config', token=tok).get('data'), ensure_ascii=False))
EOF
