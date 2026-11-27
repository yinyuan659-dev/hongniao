# 部署网页后在服务器上核对（2026-11-27 起用，替代 wuyu_check.sh）：
# 新文件在不在、「相亲物语」那一页和它的脚本是不是没有了、备案号在不在、从本机访问的状态码
cd /opt/hongniang/www/web
echo "=== files ==="
ls -la index.html
ls assets
echo "=== bundles referenced ==="
grep -o 'assets/[A-Za-z0-9_-]*\.\(js\|css\)' index.html
echo "=== wuyu should be gone ==="
ls wuyu.html wuyu-cover.jpg assets/wuyu-* 2>/dev/null && echo "STILL THERE" || echo "no wuyu files"
grep -rl '相亲物语' assets/ >/dev/null && echo "STILL HAS 相亲物语" || echo "no 相亲物语 in assets"
echo "=== icp ==="
grep -rl '蜀ICP备2024113063号-4' assets/ >/dev/null && echo "FOUND 备案号" || echo "MISSING 备案号"
grep -rl 'beian.miit.gov.cn' assets/ >/dev/null && echo "FOUND 工信部链接" || echo "MISSING 工信部链接"
echo "=== https://gphnai.com ==="
# 2026-11-27 起 80 端口只会跳到 https://gphnai.com，所以直接访问域名（服务器上域名解析到自己）
# /wuyu.html 文件没有了以后会回落到 index.html（网页会进首页），所以看的是它返回的是不是首页那一份
for p in / /index.html /wuyu.html /kyc-return.html /privacy.html /api/emojis; do
  echo "$p $(curl -s -o /dev/null -m 10 -w '%{http_code} %{content_type} %{size_download}' https://gphnai.com$p)"
done
for f in $(grep -o 'assets/[A-Za-z0-9_-]*\.\(js\|css\)' index.html); do
  echo "/$f $(curl -s -o /dev/null -m 10 -w '%{http_code} %{size_download}' https://gphnai.com/$f)"
done
echo "=== 安卓测试包 ==="
ls -la /opt/hongniang/www/app/ 2>/dev/null
echo "sha256=$(sha256sum /opt/hongniang/www/app/hongniang-test.apk 2>/dev/null | cut -c1-16)…"
echo "/app/hongniang-test.apk $(curl -s -o /dev/null -m 60 -w '%{http_code} %{content_type} %{size_download}' https://gphnai.com/app/hongniang-test.apk)"
echo "=== backup ==="
ls -d /opt/hongniang/backup/web-prev && grep -o 'assets/[A-Za-z0-9_-]*\.js' /opt/hongniang/backup/web-prev/index.html | head -3
