# 部署「领队旅行」后端（2026-11-28，样稿 design/13-travel.html）。先决条件：已经跑过 trip_1_backup.sh，新的后端源码已传到 /opt/hongniang/houduan。
# 重建后端镜像和容器。容器启动时 prisma db push 会新建 trip、trip_order 两张表，并给 user 加 5 列
# （is_leader、leader_at、leader_intro、leader_intro_pending、referral_rate），只加不改；之后让 nginx 重新解析一次后端容器的地址。
cd /opt/hongniang
echo "=== 上传的后端源码是不是新的 ==="
ls houduan/src/trip/trip.service.ts && grep -c "model Trip \|model TripOrder\|is_leader" houduan/prisma/schema.prisma || { echo "后端源码不是新的，停"; exit 1; }
Q='SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema="hongniang"; SELECT COUNT(*) FROM information_schema.columns WHERE table_schema="hongniang" AND table_name="user"; SELECT COUNT(*) FROM conversation; SELECT COUNT(*) FROM message; SELECT COUNT(*) FROM chat_group'
echo "=== 部署前：用户数 ; 表数 ; user 的列数 ; 会话数 ; 消息数 ; 群数 ==="
docker compose exec -T -e Q="$Q" mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "$Q" 2>/dev/null' </dev/null
echo "=== 重建后端（输出到文件）==="
docker compose up -d --build api > /tmp/hn_trip_up.log 2>&1 </dev/null
echo "compose exit=$?"
tail -n 6 /tmp/hn_trip_up.log
echo "=== wait api ==="
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' https://gphnai.com/api/emojis || true)
  if [ "$code" = "200" ]; then echo "api up after ${i}x3s"; break; fi
  sleep 3
done
docker exec hn-nginx nginx -s reload; sleep 2
echo "=== containers ==="; docker ps --format '{{.Names}}\t{{.Status}}' | sort
echo "=== 容器里是不是新代码 ==="; docker exec hn-api sh -c 'ls dist/src/trip/trip.service.js dist/src/im/watch.registry.js && grep -c "adminSetLeader" dist/src/admin/admin.controller.js'
echo "=== 启动日志里 prisma db push 那几行、报错行 ==="
docker logs hn-api 2>&1 | grep -iE 'database is|in sync|applying|warn|data loss' | tail -n 6
docker logs hn-api 2>&1 | grep -iE 'error|exception|fail' | grep -v 'APNIC' | tail -n 8 || true
echo "=== 部署后：用户数（不变）; 表数（应该多 2）; user 的列数（应该多 5）; 会话数 ; 消息数 ; 群数（都不变）==="
docker compose exec -T -e Q="$Q" mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "$Q" 2>/dev/null' </dev/null
echo "=== 新表的列；user 新加的列和默认值；现在有几个领队、几条线路（都应该是 0）==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT table_name, GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name IN (\"trip\",\"trip_order\") GROUP BY table_name; SELECT column_name, column_type, is_nullable, IFNULL(column_default,\"NULL\") FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name=\"user\" AND column_name IN (\"is_leader\",\"leader_at\",\"leader_intro\",\"leader_intro_pending\",\"referral_rate\"); SELECT COUNT(*) FROM user WHERE is_leader=1; SELECT COUNT(*) FROM trip" 2>/dev/null' </dev/null
echo "=== 网站、接口、WebSocket ==="
for p in / /api/emojis; do echo "$p $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://gphnai.com$p)"; done
echo "ws $(curl -s -o /dev/null -m 5 --http1.1 -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://gphnai.com/ws || true)"
echo "=== done ==="
