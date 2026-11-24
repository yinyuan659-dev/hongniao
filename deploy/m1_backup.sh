set -e
cd /opt/hongniang
mkdir -p backup
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang' | gzip > "backup/hongniang-$STAMP.sql.gz"
echo "backup=backup/hongniang-$STAMP.sql.gz size=$(du -h backup/hongniang-$STAMP.sql.gz | cut -f1)"
echo "counts(users / id_card_nonnull / real_name_len>0):"
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM user WHERE id_card IS NOT NULL; SELECT COUNT(*) FROM user WHERE LENGTH(real_name)>0"'
