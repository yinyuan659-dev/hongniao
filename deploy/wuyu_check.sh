# 部署后在服务器上核对：新网页文件在不在、从本机访问是不是 200、nginx 给游戏那一页的响应头
cd /opt/hongniang/www/web
echo "=== files ==="
ls -la index.html wuyu.html wuyu-cover.jpg
ls assets | head -20
echo "=== bundles referenced ==="
grep -o 'assets/[A-Za-z0-9_-]*\.js' index.html | head -3
grep -o 'assets/[A-Za-z0-9_-]*\.js' wuyu.html | head -3
echo "=== strings ==="
grep -rl '逛一逛' assets/ >/dev/null && echo "FOUND 大厅新文案" || echo "MISSING 大厅新文案"
grep -rl '筹备中' assets/ >/dev/null && echo "STILL HAS 筹备中" || echo "no 筹备中"
echo "=== http ==="
for p in / /wuyu.html /wuyu-cover.jpg; do echo "$p $(curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' http://127.0.0.1$p)"; done
JS=$(grep -o 'assets/wuyu-[A-Za-z0-9_-]*\.js' wuyu.html | head -1)
echo "/$JS $(curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}' http://127.0.0.1/$JS)"
echo "gzip: $(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' http://127.0.0.1/$JS) bytes over the wire"
echo "=== headers of /wuyu.html ==="
curl -sI http://127.0.0.1/wuyu.html | tr -d '\r' | grep -i -E 'cache-control|x-frame|content-type|etag|last-modified'
