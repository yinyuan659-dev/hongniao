cd /opt/hongniang
echo "=== api logs tail ==="
docker logs hn-api --tail 25 2>&1 | tail -25
echo "=== user new columns ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -e "SHOW COLUMNS FROM user"' < /dev/null 2>/dev/null | grep -E 'id_hash|real_status|real_at' || echo MISSING
echo "=== kyc_record table ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -e "SHOW TABLES"' < /dev/null 2>/dev/null | grep kyc_record || echo NO_TABLE
echo "=== kyc/status unauth ==="
curl -s http://127.0.0.1/api/kyc/status; echo
echo "=== tools ==="
(which jq >/dev/null && echo has-jq) || echo no-jq
(which python3 >/dev/null && echo has-python3) || echo no-python3
