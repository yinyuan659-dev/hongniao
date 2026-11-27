# 关掉 SRS 1985 端口的公网映射（信令已经走 nginx 的 HTTPS）。先决条件：新的 docker-compose.yml 已传上来（srs 只映射 8000/udp，nginx depends_on 多了 srs）。
# 会重建 hn-srs 容器（正在进行的通话会断），nginx 也可能被重建；之后让 nginx 重新解析一次 hn-srs。
cd /opt/hongniang
echo "=== 进行中的通话（不是 0 就停）==="
N=$(docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM call_record WHERE status IN (0,1) AND created_at > NOW() - INTERVAL 1 HOUR" 2>/dev/null' </dev/null | tr -d '\r ')
echo "$N"
[ "$N" = "0" ] || { echo "有通话在进行，先不动"; exit 1; }
cp -p docker-compose.yml "backup/docker-compose-before-close1985-$(date +%Y%m%d-%H%M%S).yml" 2>/dev/null || true
docker compose config -q && echo "compose ok" || { echo "compose 文件有错，停"; exit 1; }
grep -n '1985' docker-compose.yml | grep -v '^\s*[0-9]*:\s*#' || echo "compose 里已经没有 1985 的端口映射"
docker compose up -d > /tmp/hn_close1985.log 2>&1 </dev/null
echo "compose exit=$?"; tail -n 12 /tmp/hn_close1985.log
sleep 3
docker exec hn-nginx nginx -t 2>&1 | tail -n 1 && docker exec hn-nginx nginx -s reload
sleep 2
echo "=== containers ==="; docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' | sort
echo "=== 宿主机上谁在听 1985 / 8000 ==="; ss -ltnp | grep -E ':1985\s' || echo "1985/tcp: 没人听了"; ss -lunp | grep -E ':8000\s' | head -n 1
echo "=== SRS 容器 ==="; docker exec hn-srs sh -c 'echo CANDIDATE=$CANDIDATE'
docker exec hn-nginx sh -c 'printf "从 nginx 容器里问 SRS: "; wget -q -O - -T 5 http://hn-srs:1985/api/v1/versions | head -c 90'; echo
echo "=== 网站和接口 ==="
for p in / /api/emojis; do echo "$p $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://gphnai.com$p)"; done
echo "WebSocket 握手 $(curl -s -o /dev/null -m 5 --http1.1 -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://gphnai.com/ws || true)"
echo "=== done ==="
