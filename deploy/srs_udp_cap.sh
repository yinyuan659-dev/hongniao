# 抓 20 秒：从外面发到本机 8000/udp、8001/udp 的包（8001 没人听，是对照）。只读。
# 用法：跑这个脚本的同时，从外面的机器往这两个端口发 UDP 包。
command -v tcpdump >/dev/null || { echo "no tcpdump"; exit 0; }
IF=$(ip route get 8.8.8.8 | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") print $(i + 1)}')
echo "interface=$IF"
timeout 20 tcpdump -ni "$IF" 'udp and (dst port 8000 or dst port 8001)' 2>/dev/null > /tmp/hn_udp_cap.txt
echo "packets to :8000 = $(grep -c '\.8000: ' /tmp/hn_udp_cap.txt)   packets to :8001 = $(grep -c '\.8001: ' /tmp/hn_udp_cap.txt)"
awk '{print $3}' /tmp/hn_udp_cap.txt | sed -E 's/^[0-9]+\.[0-9]+\.([0-9]+\.[0-9]+)\.[0-9]+$/x.x.\1/' | sort | uniq -c | head -n 5
