# 上 HTTPS 之前只读看一眼服务器现状（不改任何东西）。密钥类的值一律不打印，只打印和地址有关的几行。
cd /opt/hongniang
echo "=== os ==="; . /etc/os-release; echo "$PRETTY_NAME"; date
echo "=== containers ==="; docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "=== listening 80/443 ==="; ss -ltnp | grep -E ':(80|443)\s' || echo "none"
echo "=== files (sha256, 和本机仓库里的对一下) ==="; sha256sum docker-compose.yml nginx/hongniang.conf
echo "=== .env 里和地址有关的行（不是密钥）==="; grep -E '^(PUBLIC_BASE|SRS_SERVER|SRS_API|KYC_PROVIDER|KYC_RETURN_BASE)=' .env
echo "=== .env 的条目名（不带值）==="; sed -E 's/=.*//' .env | grep -v '^#' | grep -v '^$' | tr '\n' ' '; echo
echo "=== api 容器里的地址类环境变量 ==="; docker exec hn-api printenv | grep -E '^(PUBLIC_RES_BASE|SITE_BASE|HALL_H5_URL|KYC_PROVIDER|KYC_RETURN_BASE|SRS_API|SRS_SERVER)=' | sort
echo "=== certbot / acme ==="; command -v certbot || echo "certbot: 没装"; ls -d /etc/letsencrypt 2>/dev/null || echo "/etc/letsencrypt: 没有"; ls ~/.acme.sh 2>/dev/null | head -3 || true
apt-cache policy certbot 2>/dev/null | head -3
echo "=== 能不能连上 Let's Encrypt ==="; curl -s -o /dev/null -m 15 -w 'acme-v02 directory: %{http_code} %{time_total}s\n' https://acme-v02.api.letsencrypt.org/directory
echo "=== 域名从服务器自己看 ==="; getent hosts gphnai.com www.gphnai.com
for h in gphnai.com www.gphnai.com; do echo "http://$h/ $(curl -s -o /dev/null -m 10 -w '%{http_code} %{size_download}' http://$h/)"; done
echo "=== backup 目录 ==="; ls -la backup 2>/dev/null | head -20
echo "=== disk ==="; df -h / | tail -1
