# 部署「牵豆 + 视频按分钟收费」的后端（2026-11-27）。先决条件：已经跑过备份（srs_1_backup.sh：配置 + 数据库 + 上一版后端源码），新的后端源码已传到 /opt/hongniang/houduan。
# 重建后端镜像和容器。容器启动时 prisma db push 会给 call_record 加 3 列（payer_id、price_micro、paid_minutes），只加不改；之后让 nginx 重新解析一次后端容器的地址。
cd /opt/hongniang
echo "=== 上传的后端源码是不是新的 ==="
ls houduan/src/common/video-fee.ts && grep -c "paidMinutes" houduan/prisma/schema.prisma houduan/src/call/call.service.ts || { echo "后端源码不是新的，停"; exit 1; }
echo "=== 部署前 call_record 的列 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name=\"call_record\"; SELECT COUNT(*) FROM call_record" 2>/dev/null' </dev/null
echo "=== 重建后端（输出到文件）==="
docker compose up -d --build api > /tmp/hn_qiandou_up.log 2>&1 </dev/null
echo "compose exit=$?"
tail -n 6 /tmp/hn_qiandou_up.log
echo "=== wait api ==="
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' https://gphnai.com/api/emojis || true)
  if [ "$code" = "200" ]; then echo "api up after ${i}x3s"; break; fi
  sleep 3
done
docker exec hn-nginx nginx -s reload; sleep 2
echo "=== containers ==="; docker ps --format '{{.Names}}\t{{.Status}}' | sort
echo "=== 容器里是不是新代码 ==="; docker exec hn-api sh -c 'ls dist/src/common/video-fee.js && grep -c "feeTick" dist/src/call/call.service.js'
echo "=== 启动日志里 prisma db push 那几行、报错行 ==="
docker logs hn-api 2>&1 | grep -iE 'database is|in sync|applying|warn|data loss' | tail -n 6
docker logs hn-api 2>&1 | grep -iE 'error|exception|fail' | grep -v 'APNIC' | tail -n 8 || true
echo "=== 部署后 call_record 的列、行数（行数应该不变，多 3 列）==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name=\"call_record\"; SELECT COUNT(*) FROM call_record; SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null
echo "=== 网站、接口、WebSocket ==="
for p in / /api/emojis; do echo "$p $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://gphnai.com$p)"; done
echo "ws $(curl -s -o /dev/null -m 5 --http1.1 -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://gphnai.com/ws || true)"
echo "=== done ==="
