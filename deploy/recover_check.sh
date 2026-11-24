cd /opt/hongniang
q() { docker compose exec -T mysql sh -c "exec mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" hongniang -N -e \"$1\" 2>/dev/null" </dev/null; }
echo "=== users: id short status merged_into real device_id(has ~?) ==="
q "SELECT id, short_id, status, IFNULL(merged_into,'-'), real_status, IF(device_id LIKE '%~%','freed','own') FROM user ORDER BY id"
echo "=== user_device: id user kind label via revoked? ==="
q "SELECT id, user_id, kind, label, via, IF(revoked_at IS NULL,'active','revoked') FROM user_device ORDER BY id"
echo "=== kyc_record: purpose provider status count ==="
q "SELECT purpose, provider, status, COUNT(*) FROM kyc_record GROUP BY purpose, provider, status"
echo "=== counts: users ; tables ==="
q "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='hongniang'"
echo "=== api error-ish log lines ==="
docker logs hn-api 2>&1 | grep -iE 'error|exception' | grep -v 'APNIC' | tail -n 8 || true
echo "=== done ==="
