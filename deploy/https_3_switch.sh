# 切到 https://gphnai.com：先决条件是证书已经在 /etc/letsencrypt/live/gphnai.com/，新的 docker-compose.yml 和 nginx/hongniang.conf 已经传上来。
# 做三件事：① 用临时容器验证新的 nginx 配置（不通过就停，线上不受影响）② .env 的 PUBLIC_BASE 换成 https://gphnai.com ③ docker compose up -d（只会重建配置变了的 nginx、api；不重新构建镜像，不动数据卷）
cd /opt/hongniang
echo "=== compose 文件检查 ==="
docker compose config -q && echo "compose ok" || { echo "compose 文件有错，停"; exit 1; }
echo "=== 新 nginx 配置检查（临时容器，接同一个内网，能解析 hn-api / hn-minio）==="
NET=$(docker inspect hn-nginx --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
docker run --rm --network "$NET" \
  -v /opt/hongniang/nginx/hongniang.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/letsencrypt:/etc/letsencrypt:ro nginx:1.27-alpine nginx -t > /tmp/hn_nginx_t2.log 2>&1; T=$?
tail -n 3 /tmp/hn_nginx_t2.log
[ "$T" = "0" ] || { echo "新 nginx 配置不通过，停（什么都没切）"; exit 1; }

echo "=== .env ==="
sed -i 's|^PUBLIC_BASE=.*|PUBLIC_BASE=https://gphnai.com|' .env
grep -E '^PUBLIC_BASE=' .env; stat -c '%a %U' .env

echo "=== docker compose up -d ==="
# 输出不接管道（接了会把重建打断），重定向到文件，跑完再看
docker compose up -d > /tmp/hn_https_up.log 2>&1 </dev/null
echo "compose exit=$?"
tail -n 12 /tmp/hn_https_up.log
echo "=== wait api ==="
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' https://gphnai.com/api/emojis || true)
  if [ "$code" = "200" ]; then echo "api up after ${i}x3s"; break; fi
  sleep 3
done
echo "=== containers ==="
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | sort
echo "=== api 容器里的地址类环境变量 ==="
docker exec hn-api printenv | grep -E '^(PUBLIC_RES_BASE|SITE_BASE|HALL_H5_URL|KYC_PROVIDER|SRS_API|SRS_SERVER)=' | sort
echo "=== api 启动后的报错行 ==="
docker logs hn-api 2>&1 | grep -iE 'error|exception|fail' | grep -v 'APNIC' | tail -n 10 || true
echo "=== users ; tables（应该和切之前一样）==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null
echo "=== 各种地址 ==="
show() { echo "$1 -> $(curl -s -o /dev/null -m 10 -w '%{http_code} %{redirect_url} size=%{size_download} proto=%{http_version}' "$1")"; }
show https://gphnai.com/
show https://gphnai.com/index.html
show https://gphnai.com/api/emojis
show https://gphnai.com/kyc-return.html
show https://gphnai.com/privacy.html
show https://gphnai.com/app/hongniang-test.apk
show https://www.gphnai.com/abc?x=1
show http://gphnai.com/abc?x=1
show http://www.gphnai.com/
show http://120.55.59.158/api/emojis
echo "https://120.55.59.158/ (证书名对不上是正常的，-k 忽略) -> $(curl -sk -o /dev/null -m 10 -w '%{http_code} %{redirect_url}' https://120.55.59.158/)"
echo "=== WebSocket 握手（要 101）==="
curl -s -o /dev/null -m 5 --http1.1 -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://gphnai.com/ws || true
echo "=== 证书 ==="
echo | openssl s_client -connect gphnai.com:443 -servername gphnai.com 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null
echo "=== 续期演练（不真的换证书）==="
certbot renew --dry-run > /tmp/hn_certbot_dry.log 2>&1 </dev/null; echo "dry-run exit=$?"; grep -E 'success|Congratulations|failed|error' /tmp/hn_certbot_dry.log | head -5
echo "=== done ==="
