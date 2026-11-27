# 通话信令挪到 HTTPS 之前：配置、数据库、后端源码各留一份；顺便看一眼现在的通话节点和 SRS 的配置。只读 + 写 backup/。
set -e
cd /opt/hongniang
STAMP=$(date +%Y%m%d-%H%M%S)
D="backup/conf-$STAMP"
mkdir -p "$D"; chmod 700 backup "$D"
cp -a docker-compose.yml "$D/"; cp -a nginx "$D/nginx"; cp -a .env "$D/.env"; chmod 600 "$D/.env"
echo "conf backup: $D"
rm -rf backup/houduan-prev
cp -a houduan backup/houduan-prev
echo "backend source backup: backup/houduan-prev ($(find backup/houduan-prev -type f | wc -l) files)"
grep -n 'const base' backup/houduan-prev/src/srs/srs.service.ts || true
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang 2>/dev/null' </dev/null | gzip > "backup/hongniang-$STAMP.sql.gz"
chmod 600 "backup/hongniang-$STAMP.sql.gz"
echo "db backup: backup/hongniang-$STAMP.sql.gz size=$(du -h backup/hongniang-$STAMP.sql.gz | cut -f1)"
echo "=== users ; tables ; 进行中的通话 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"; SELECT COUNT(*) FROM call_record WHERE status IN (0,1) AND created_at > NOW() - INTERVAL 1 HOUR" 2>/dev/null' </dev/null
echo "=== 通话节点表 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -e "SELECT id, name, ip, api_port, priority, max_connections, enabled, is_default FROM srs_node" 2>/dev/null' </dev/null
echo "=== .env 里的 SRS ==="; grep -E '^SRS_' .env
echo "=== SRS 容器：候选地址相关的配置 ==="
docker exec hn-srs sh -c 'echo CANDIDATE=$CANDIDATE; grep -nE "candidate|api_as_candidates|resolve_api_domain|listen|use_auto_detect" conf/rtc.conf' 2>&1 | head -20
echo "=== SRS 现在从 nginx 容器里够不够得着 ==="
docker exec hn-nginx sh -c 'wget -q -O - -T 5 http://hn-srs:1985/api/v1/versions 2>&1 | head -c 200'; echo
echo "=== done ==="
