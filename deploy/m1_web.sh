cd /opt/hongniang/www/web
echo "=== index.html js bundle ==="
grep -o 'assets/[A-Za-z0-9_-]*\.js' index.html | head
echo "=== new kyc strings present in bundle? ==="
grep -rl '开始刷脸认证' assets/ >/dev/null && echo "FOUND: 实人认证页" || echo "MISSING kyc page"
grep -rl '真人认证' assets/ >/dev/null && echo "FOUND: 真人认证标" || echo "MISSING badge"
grep -rl '模拟完成刷脸' assets/ >/dev/null && echo "FOUND: mock 刷脸页" || echo "MISSING mock page"
echo "=== web index http ==="
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
