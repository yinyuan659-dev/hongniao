set -e
cd /opt/hongniang
mkdir -p backup
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang 2>/dev/null' </dev/null | gzip > "backup/hongniang-$STAMP.sql.gz"
echo "backup=backup/hongniang-$STAMP.sql.gz size=$(du -h backup/hongniang-$STAMP.sql.gz | cut -f1)"
echo "=== users ; kyc_record ; real_status=1 ; tables ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM kyc_record; SELECT COUNT(*) FROM user WHERE real_status=1; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null
echo "=== KYC_ keys already in .env (names only) ==="
grep -o '^KYC_[A-Z_]*' .env || echo "(none)"
echo "=== api container ==="
docker ps --filter name=hn-api --format '{{.Names}} {{.Status}}'
echo "=== done ==="
