# 申请 HTTPS 证书（Let's Encrypt，certbot 装在宿主机上，webroot 方式）。
# 先决条件：/opt/hongniang/nginx/hongniang.conf 里 80 端口已经有 /.well-known/acme-challenge/ 这一段（指向 www/acme），本脚本会重新加载 nginx。
# 这一步不动 443、不动 .env、不重建任何容器；网站照常用 80 访问。
cd /opt/hongniang
mkdir -p www/acme/.well-known/acme-challenge
echo "=== nginx 重新加载（容器里看到的配置要有 acme 这一段）==="
docker exec hn-nginx grep -c 'acme-challenge' /etc/nginx/conf.d/default.conf || { echo "容器里的配置没更新，停"; exit 1; }
docker exec hn-nginx nginx -t > /tmp/hn_nginx_t.log 2>&1; T=$?
tail -n 2 /tmp/hn_nginx_t.log
[ "$T" = "0" ] || { echo "nginx -t 不通过，停（没有重新加载，网站不受影响）"; exit 1; }
docker exec hn-nginx nginx -s reload
sleep 2
echo probe-ok > www/acme/.well-known/acme-challenge/probe.txt
for h in gphnai.com www.gphnai.com; do echo "http://$h/.well-known/acme-challenge/probe.txt -> $(curl -s -m 10 http://$h/.well-known/acme-challenge/probe.txt)"; done
rm -f www/acme/.well-known/acme-challenge/probe.txt

echo "=== 装 certbot ==="
if ! command -v certbot >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot > /tmp/hn_certbot_apt.log 2>&1 </dev/null
  echo "apt exit=$?"; tail -n 3 /tmp/hn_certbot_apt.log
fi
certbot --version

echo "=== 申请证书 ==="
# 没有填邮箱（--register-unsafely-without-email）：Let's Encrypt 已经不发到期提醒邮件了，续期靠下面的定时器
certbot certonly --webroot -w /opt/hongniang/www/acme -d gphnai.com -d www.gphnai.com \
  --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring > /tmp/hn_certbot_issue.log 2>&1 </dev/null
echo "certbot exit=$?"; tail -n 12 /tmp/hn_certbot_issue.log

echo "=== 续期后让 nginx 重新读证书 ==="
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/hn-nginx-reload.sh <<'EOF'
#!/bin/sh
# certbot 续期成功后执行：让容器里的 nginx 重新读证书
docker exec hn-nginx nginx -s reload
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/hn-nginx-reload.sh
ls -la /etc/letsencrypt/renewal-hooks/deploy/

echo "=== 证书 ==="
certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry'
ls -la /etc/letsencrypt/live/gphnai.com/ 2>/dev/null
echo "=== 自动续期的定时器 ==="
systemctl list-timers --all 2>/dev/null | grep -i certbot || echo "没有 certbot 定时器"
echo "=== done ==="
