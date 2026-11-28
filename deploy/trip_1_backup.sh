# 部署「领队旅行」后端之前（2026-11-28）：配置、数据库、上一版后端源码各留一份；看一眼库里现在的样子。只读 + 写 backup/。
# 上一版后端源码放在带时间的目录里（backup/houduan-时间），不覆盖以前留的那份。
set -e
cd /opt/hongniang
STAMP=$(date +%Y%m%d-%H%M%S)
D="backup/conf-$STAMP"
mkdir -p "$D"; chmod 700 backup "$D"
cp -a docker-compose.yml "$D/"; cp -a nginx "$D/nginx"; cp -a .env "$D/.env"; chmod 600 "$D/.env"
echo "conf backup: $D"
cp -a houduan "backup/houduan-$STAMP"
echo "backend source backup: backup/houduan-$STAMP ($(find backup/houduan-$STAMP -type f | wc -l) files)"
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang 2>/dev/null' </dev/null | gzip > "backup/hongniang-$STAMP.sql.gz"
chmod 600 "backup/hongniang-$STAMP.sql.gz"
echo "db backup: backup/hongniang-$STAMP.sql.gz size=$(du -h backup/hongniang-$STAMP.sql.gz | cut -f1)"
gzip -t "backup/hongniang-$STAMP.sql.gz" && echo "db backup gzip ok, CREATE TABLE 条数: $(zcat backup/hongniang-$STAMP.sql.gz | grep -c '^CREATE TABLE')"
echo "=== 用户数 ; 表数 ; 会话数 ; 消息数 ; 群数 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"; SELECT COUNT(*) FROM conversation; SELECT COUNT(*) FROM message; SELECT COUNT(*) FROM chat_group" 2>/dev/null' </dev/null
echo "=== 库里现在有没有线路的表、user 表有没有领队那几列（应该都没有）==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema=\"hongniang\" AND table_name IN (\"trip\",\"trip_order\"); SELECT column_name FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name=\"user\" AND column_name IN (\"is_leader\",\"leader_at\",\"leader_intro\",\"leader_intro_pending\",\"referral_rate\")" 2>/dev/null' </dev/null
echo "(以上为空 = 没有)"
echo "=== user 表现在有几列 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name=\"user\"" 2>/dev/null' </dev/null
echo "=== done ==="
