cd /opt/hongniang
echo "=== counts: users ; id_card_nonnull ; real_name_len>0 ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM user WHERE id_card IS NOT NULL; SELECT COUNT(*) FROM user WHERE LENGTH(real_name)>0"' < /dev/null
echo "=== done ==="
