cd /opt/hongniang
# 第一个参数：mock / aliyun，把实人认证切到哪种（自动测试用 mock，测完切回 aliyun）。不给就不改。
MODE="$1"
if [ "$MODE" = "mock" ] || [ "$MODE" = "aliyun" ]; then
  sed -i "s/^KYC_PROVIDER=.*/KYC_PROVIDER=$MODE/" .env
  echo "KYC_PROVIDER in .env -> $(grep '^KYC_PROVIDER=' .env)"
fi
# 第二个参数：build 就重建镜像（上传了新后端源码时用）；不给只按新的环境变量重启
if [ "$2" = "build" ]; then
  docker compose up -d --build api > /tmp/hn_recover_up.log 2>&1 </dev/null
else
  docker compose up -d api > /tmp/hn_recover_up.log 2>&1 </dev/null
fi
echo "compose exit=$?"
tail -n 6 /tmp/hn_recover_up.log
echo "=== wait api ==="
ok=0
for i in $(seq 1 60); do
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/emojis || true)
  up=$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' hn-api 2>/dev/null)
  if [ "$code" = "200" ] && docker logs hn-api 2>&1 | grep -q 'Nest application successfully started'; then echo "api up after ${i}x3s ($up)"; ok=1; break; fi
done
[ "$ok" = "1" ] || echo "API NOT UP: code=$code state=$up"
echo "=== containers ==="
docker ps --format '{{.Names}} {{.Status}}' | sort
echo "=== api env ==="
docker compose exec -T api sh -c 'echo "KYC_PROVIDER=$KYC_PROVIDER id_len=${#KYC_ALIYUN_ACCESS_KEY_ID}"' </dev/null
echo "=== new table / columns ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"; SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=\"hongniang\" AND ((table_name=\"user\" AND column_name=\"merged_into\") OR (table_name=\"kyc_record\" AND column_name IN (\"purpose\",\"target_user_id\",\"device_id\")) OR (table_name=\"user_device\" AND column_name=\"device_id\")); SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM user_device" 2>/dev/null' </dev/null
echo "=== api error-ish log lines ==="
docker logs hn-api 2>&1 | grep -iE 'error|exception|unknown|fail' | grep -v 'APNIC' | tail -n 12 || true
echo "=== web ==="
grep -o 'assets/[A-Za-z0-9_-]*\.js' /opt/hongniang/www/web/index.html | head -n 2
echo "=== done ==="
