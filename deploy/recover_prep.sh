cd /opt/hongniang
# 测试准备：$1 = 要加余额的测试号短号（可不给），$2 = 加多少元。后台密码只在服务器上用，不打印。
# 顺便清掉「刷脸找回每日次数」的计数（测试跑多了会撞上限）。
echo "=== reset kyc daily counters ==="
docker compose exec -T redis sh -c "redis-cli --scan --pattern 'kyc:*' | xargs -r redis-cli del" </dev/null
if [ -n "$1" ]; then
  B=http://127.0.0.1/api
  ADMINPW=$(grep -E '^ADMIN_INIT_PASSWORD=' .env | cut -d= -f2-)
  AT=$(curl -s $B/admin/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$ADMINPW\"}" | jq -r .data.token)
  echo "admin token len=${#AT}"
  curl -s $B/admin/ai-wallet/credit -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
    -d "{\"who\":\"$1\",\"yuan\":$2,\"refKey\":\"test-20261124-$1\",\"note\":\"测试并号\"}" | jq -c '{code,msg,data}'
fi
echo "=== done ==="
