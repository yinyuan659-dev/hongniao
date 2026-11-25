cd /opt/hongniang
# 改名后的核对：线上跑着的后端、网页、安装包里是不是都已经是新名字
echo "=== api: 新旧名字在运行中的后端代码里各出现几次 ==="
docker compose exec -T api sh -c 'f=$(find /app/dist -name ai.service.js | head -n 1); echo "$f new=$(grep -c 一线牵 "$f") old=$(grep -c -E "心之音|良媒" "$f")"' </dev/null
echo "=== api: 已删的接口应该是 404 ==="
# 这个后端出错时 HTTP 状态码也是 200，真正的结果在返回内容的 code 里，所以要看内容
for p in app/review-mode auth/demo-login; do echo "$p -> $(curl -s -X POST http://127.0.0.1/api/$p | cut -c1-60)"; done
echo "=== web ==="
grep -o '<title>[^<]*</title>' www/web/index.html
ls -l www/web/favicon.png www/web/apple-touch-icon.png | awk '{print $5, $9}'
for f in terms privacy support; do echo "$f.html old=$(grep -c -E '心之音|HeartChat|良媒|Liangmei' www/web/$f.html) new=$(grep -c -E '一线牵|Yixianqian' www/web/$f.html)"; done
echo "=== apk ==="
stat -c '%s bytes' www/app/hongniang-test.apk
sha256sum www/app/hongniang-test.apk | cut -d' ' -f1
echo "=== api log errors ==="
docker logs hn-api 2>&1 | grep -iE 'error|exception' | grep -v APNIC | tail -n 5 || true
echo "=== done ==="
