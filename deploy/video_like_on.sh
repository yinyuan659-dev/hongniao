# 把「视频见面要互相喜欢」打开（默认就是打开的；送审和正式上线时必须是打开的）：没互相喜欢的两个人不能视频。
# 用法（本机）：python deploy\remote.py run deploy\video_like_on.sh 60      改完 30 秒内生效，不用重启。
# 这个开关只决定服务器放不放行视频通话，App 的按钮和页面不随它变。管理员密码在服务器上从 .env 里取，不打印。
python3 - <<'EOF'
import json, re, urllib.request
VALUE = True
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
    r = call('/match/config', {'videoNeedLike': VALUE}, tok, 'PUT')
    print('now:', json.dumps(r.get('data', r), ensure_ascii=False))
EOF
