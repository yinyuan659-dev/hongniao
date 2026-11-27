# 部署「聊天放开、视频要互相喜欢」的后端（2026-11-27）。先决条件：已经跑过备份（srs_1_backup.sh：配置 + 数据库 + 上一版后端源码），新的后端源码已传到 /opt/hongniang/houduan。
# 只重建后端镜像和容器，不改表结构；之后让 nginx 重新解析一次后端容器的地址。
cd /opt/hongniang
echo "=== 上传的后端源码是不是新的 ==="
grep -c "assertCanVideo" houduan/src/common/chat-gate.ts houduan/src/call/call.service.ts || { echo "后端源码不是新的，停"; exit 1; }
echo "=== 重建后端（输出到文件）==="
docker compose up -d --build api > /tmp/hn_openchat_up.log 2>&1 </dev/null
echo "compose exit=$?"
tail -n 6 /tmp/hn_openchat_up.log
echo "=== wait api ==="
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' https://gphnai.com/api/emojis || true)
  if [ "$code" = "200" ]; then echo "api up after ${i}x3s"; break; fi
  sleep 3
done
docker exec hn-nginx nginx -s reload; sleep 2
echo "=== containers ==="; docker ps --format '{{.Names}}\t{{.Status}}' | sort
echo "=== 容器里是不是新代码 ==="; docker exec hn-api sh -c 'grep -c "assertCanVideo" dist/src/common/chat-gate.js dist/src/call/call.service.js'
echo "=== api 报错行 ==="; docker logs hn-api 2>&1 | grep -iE 'error|exception|fail' | grep -v 'APNIC' | tail -n 8 || true
echo "=== users ; tables（应该和部署前一样）==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null
echo "=== 网站、接口、WebSocket、通话信令 ==="
for p in / /api/emojis; do echo "$p $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://gphnai.com$p)"; done
echo "ws $(curl -s -o /dev/null -m 5 --http1.1 -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://gphnai.com/ws || true)"
echo "=== done ==="
