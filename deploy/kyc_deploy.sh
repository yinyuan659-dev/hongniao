cd /opt/hongniang
# 输出不接管道（接了会把重建打断），重定向到文件，跑完再看
docker compose up -d --build api > /tmp/hn_kyc_up.log 2>&1 </dev/null
echo "compose exit=$?"
tail -n 12 /tmp/hn_kyc_up.log
echo "=== wait api ==="
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/emojis || true)
  if [ "$code" = "200" ]; then echo "api up after ${i}x3s"; break; fi
  sleep 3
done
echo "=== containers ==="
docker ps --format '{{.Names}} {{.Status}}' | sort
echo "=== api env (provider + lengths only) ==="
docker compose exec -T api sh -c 'echo "KYC_PROVIDER=$KYC_PROVIDER id_len=${#KYC_ALIYUN_ACCESS_KEY_ID} secret_len=${#KYC_ALIYUN_ACCESS_KEY_SECRET} scene_len=${#KYC_ALIYUN_SCENE_ID} SITE_BASE=$SITE_BASE"' </dev/null
echo "=== api error-ish log lines since start ==="
docker logs hn-api 2>&1 | grep -iE 'error|exception|fail' | grep -v 'APNIC' | tail -n 10 || true
echo "=== web ==="
grep -o 'assets/[A-Za-z0-9_-]*\.js' /opt/hongniang/www/web/index.html | head -n 3
grep -rl '正在核对认证结果' /opt/hongniang/www/web/assets/ >/dev/null && echo "FOUND: 结果页" || echo "MISSING: 结果页"
curl -s -o /dev/null -w 'kyc-return.html http=%{http_code}\n' http://127.0.0.1/kyc-return.html
echo "=== done ==="
