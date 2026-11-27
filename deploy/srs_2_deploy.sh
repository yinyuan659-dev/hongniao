# 通话信令挪到 HTTPS（第一段，1985 端口先不关）：
# 先决条件：新的后端源码已传到 /opt/hongniang/houduan，新的 nginx/hongniang.conf（多了 /rtc/v1/whip|whep/ 这一段）已传上来。
# ① 验 nginx 新配置 ② .env 的 SRS_API 换成 https://gphnai.com ③ 重建后端镜像和容器 ④ nginx 重新加载 ⑤ 用管理接口把通话节点改成 gphnai.com:443
cd /opt/hongniang
echo "=== 上传的后端源码里有没有这次的改动 ==="
grep -n "apiPort === 443" houduan/src/srs/srs.service.ts || { echo "后端源码不是新的，停"; exit 1; }
echo "=== 新 nginx 配置检查（临时容器）==="
NET=$(docker inspect hn-nginx --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$NET" -v /opt/hongniang/nginx/hongniang.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/letsencrypt:/etc/letsencrypt:ro nginx:1.27-alpine nginx -t > /tmp/hn_nginx_t3.log 2>&1; T=$?
tail -n 2 /tmp/hn_nginx_t3.log
[ "$T" = "0" ] || { echo "新 nginx 配置不通过，停（什么都没动）"; exit 1; }

echo "=== .env ==="
sed -i 's|^SRS_API=.*|SRS_API=https://gphnai.com|' .env
grep -E '^SRS_' .env; stat -c '%a %U' .env

echo "=== 重建后端（输出到文件）==="
docker compose up -d --build api > /tmp/hn_srs_up.log 2>&1 </dev/null
echo "compose exit=$?"
tail -n 8 /tmp/hn_srs_up.log
echo "=== wait api ==="
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' https://gphnai.com/api/emojis || true)
  if [ "$code" = "200" ]; then echo "api up after ${i}x3s"; break; fi
  sleep 3
done
echo "=== nginx 重新加载（后端容器换了，内网地址可能变）==="
docker exec hn-nginx grep -c 'rtc/v1' /etc/nginx/conf.d/default.conf
docker exec hn-nginx nginx -t 2>&1 | tail -n 1 && docker exec hn-nginx nginx -s reload
sleep 2
echo "=== containers ==="; docker ps --format '{{.Names}}\t{{.Status}}' | sort
echo "=== api 报错行 ==="; docker logs hn-api 2>&1 | grep -iE 'error|exception|fail' | grep -v 'APNIC' | tail -n 8 || true
echo "=== users ; tables ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null

echo "=== 用管理接口改通话节点（密码从 .env 里取，不打印）==="
python3 - <<'EOF'
import json, re, urllib.request
env = open('/opt/hongniang/.env', encoding='utf-8').read()
pw = re.search(r'(?m)^ADMIN_INIT_PASSWORD=(.*)$', env).group(1).strip()
def call(path, body=None, token=None):
    req = urllib.request.Request('https://gphnai.com/api/admin' + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})},
                                 method='POST' if body is not None else 'GET')
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    except urllib.error.HTTPError as e:
        return {'http': e.code, 'msg': e.read().decode('utf-8', 'replace')[:120]}
r = call('/login', {'username': 'admin', 'password': pw})
d = r.get('data') or {}
tok = d.get('token') if isinstance(d, dict) else None
print('admin login:', 'ok' if tok else ('FAILED %s' % {k: v for k, v in r.items() if k != 'data'}))
if tok:
    nodes = (call('/srs-nodes', token=tok).get('data') or {}).get('nodes') or []
    print('before:', [(n['id'], n['ip'], n['apiPort'], n['enabled'], n['isDefault']) for n in nodes])
    if len(nodes) == 1:
        n = nodes[0]
        if (n['ip'], n['apiPort']) != ('gphnai.com', 443):
            u = call('/srs-nodes/%d' % n['id'], {'ip': 'gphnai.com', 'apiPort': 443, 'remark': '2026-11-27 信令改走 https://gphnai.com（nginx 转给 SRS）；媒体仍是本机 UDP 8000'}, tok)
            print('update code:', u.get('code', u))
        nodes = (call('/srs-nodes', token=tok).get('data') or {}).get('nodes') or []
        print('after: ', [(n['id'], n['ip'], n['apiPort'], n['enabled'], n['isDefault']) for n in nodes])
    else:
        print('节点不是正好 1 个，没有改，先看一下')
EOF
echo "=== 信令入口（空请求应该被 SRS 拒绝，而不是 404 / 502）==="
for p in whip whep; do echo "POST /rtc/v1/$p/ -> $(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST -H 'Content-Type: application/sdp' --data 'v=0' "https://gphnai.com/rtc/v1/$p/?app=live&stream=probe_$p")"; done
echo "GET /rtc/v1/whip/ -> $(curl -s -o /dev/null -m 10 -w '%{http_code}' 'https://gphnai.com/rtc/v1/whip/')"
echo "SRS 管理接口不应该能从域名访问：/api/v1/versions -> $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://gphnai.com/api/v1/versions)  /rtc/v1/play/ -> $(curl -s -o /dev/null -m 10 -w '%{http_code} %{content_type}' https://gphnai.com/rtc/v1/play/)"
echo "=== done ==="
