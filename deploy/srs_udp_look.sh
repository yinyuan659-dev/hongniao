# 看媒体端口 UDP 8000 的情况（只读）：谁在听、防火墙规则、最近 SRS 日志里和测试流有关的行；再抓 25 秒看有没有 UDP 包进来。
# 用法：先在本机开始推流测试，同时跑这个脚本。
echo "=== 谁在听 8000/udp ==="; ss -lunp | grep -E ':8000\s' || echo "没有"
echo "=== 宿主机防火墙 ==="; (ufw status 2>/dev/null | head -n 5) || true; iptables -S INPUT 2>/dev/null | head -n 6
echo "=== docker 对 8000/udp 的转发规则 ==="; iptables -t nat -S DOCKER 2>/dev/null | grep -E '8000|1985' || echo "没有"
echo "=== 抓 25 秒：到本机 8000/udp 的包（按来源地址计数，不含内网）==="
if command -v tcpdump >/dev/null; then
  timeout 25 tcpdump -ni any -c 400 'udp port 8000' 2>/dev/null | awk '{print $5, $6, $7}' | sed -E 's/\.[0-9]+ > / > /; s/\.[0-9]+:$//' | sort | uniq -c | sort -rn | head -n 8
  echo "(上面没有行 = 25 秒里一个包也没有)"
else
  echo "没有 tcpdump，改看内核计数器"
  A=$(awk '/^Udp:/ && $2 ~ /^[0-9]+$/ {print $2}' /proc/net/snmp); sleep 25; B=$(awk '/^Udp:/ && $2 ~ /^[0-9]+$/ {print $2}' /proc/net/snmp)
  echo "宿主机 UDP InDatagrams 25 秒内增加：$((B - A))（经 docker 转发的包不一定算在这里）"
  docker exec hn-srs sh -c 'cat /proc/net/snmp | grep ^Udp: | tail -n 1'
fi
echo "=== SRS 日志里最近和 selftest 有关的行 ==="
docker logs --since 3m hn-srs 2>&1 | grep -iE 'selftest|stun|dtls|rtc.*session|ice' | tail -n 14 | cut -c1-240
