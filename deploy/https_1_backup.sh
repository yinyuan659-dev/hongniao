# 上 HTTPS / 换域名之前：把服务器上现在的配置和数据库各留一份（出问题能换回去）。只读 + 写 backup/，不改别的。
set -e
cd /opt/hongniang
STAMP=$(date +%Y%m%d-%H%M%S)
D="backup/conf-$STAMP"
mkdir -p "$D"
chmod 700 backup "$D"
cp -a docker-compose.yml "$D/"
cp -a nginx "$D/nginx"
cp -a .env "$D/.env"          # 含密钥：目录 700、文件保持 600，不离开服务器
chmod 600 "$D/.env"
echo "conf backup: $D"
ls -la "$D" "$D/nginx"
# 数据库：这次不改表，但 api 容器会重建（启动时会跑 prisma db push），先留一份
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang 2>/dev/null' </dev/null | gzip > "backup/hongniang-$STAMP.sql.gz"
chmod 600 "backup/hongniang-$STAMP.sql.gz"
echo "db backup: backup/hongniang-$STAMP.sql.gz size=$(du -h backup/hongniang-$STAMP.sql.gz | cut -f1)"
echo "=== users ; tables ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null
echo "=== done ==="
