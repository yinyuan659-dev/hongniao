# 部署群聊后端之前（2026-11-27）：配置、数据库、上一版后端源码各留一份；看一眼库里现在有没有群的表。只读 + 写 backup/。
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
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang 2>/dev/null' </dev/null | gzip > "backup/hongniang-$STAMP.sql.gz"
chmod 600 "backup/hongniang-$STAMP.sql.gz"
echo "db backup: backup/hongniang-$STAMP.sql.gz size=$(du -h backup/hongniang-$STAMP.sql.gz | cut -f1)"
gzip -t "backup/hongniang-$STAMP.sql.gz" && echo "db backup gzip ok, CREATE TABLE 条数: $(zcat backup/hongniang-$STAMP.sql.gz | grep -c '^CREATE TABLE')"
echo "=== 用户数 ; 表数 ; 会话数 ; 消息数 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"; SELECT COUNT(*) FROM conversation; SELECT COUNT(*) FROM message" 2>/dev/null' </dev/null
echo "=== 库里现在有没有群的表（应该没有）==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema=\"hongniang\" AND table_name IN (\"chat_group\",\"group_member\")" 2>/dev/null' </dev/null
echo "(以上为空 = 没有)"
echo "=== conversation 表现在的列 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=\"hongniang\" AND table_name=\"conversation\"" 2>/dev/null' </dev/null
echo "=== done ==="
