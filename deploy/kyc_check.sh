cd /opt/hongniang
echo "=== users ; real_status=1 ; tables ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT COUNT(*) FROM user; SELECT COUNT(*) FROM user WHERE real_status=1; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\"hongniang\"" 2>/dev/null' </dev/null
echo "=== kyc_record: provider status count ==="
docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N -e "SELECT provider, status, COUNT(*) FROM kyc_record GROUP BY provider, status" 2>/dev/null' </dev/null
echo "=== api KycAliyun warnings ==="
docker logs hn-api 2>&1 | grep 'KycAliyun' | tail -n 5 || true
echo "=== api error-ish log lines ==="
docker logs hn-api 2>&1 | grep -iE 'error|exception' | grep -v 'APNIC' | tail -n 5 || true
echo "=== leftover tmp ==="
ls /opt/hongniang/kyc.env.tmp 2>/dev/null || echo "kyc.env.tmp gone"
echo "=== done ==="
