# 查通话信令经 nginx 转发的情况（只读）
cd /opt/hongniang
echo "=== nginx 最近的报错 ==="
docker logs --since 10m hn-nginx 2>&1 | grep -E 'rtc/v1|upstream' | tail -n 6 | cut -c1-330
echo "=== 从 nginx 容器里直接问 SRS（不经过转发）==="
docker exec hn-nginx sh -c 'for p in whip whep; do printf "POST hn-srs:1985/rtc/v1/$p/ -> "; wget -q -S -O - -T 5 --post-data "v=0" --header "Content-Type: application/sdp" "http://hn-srs:1985/rtc/v1/$p/?app=live&stream=probe" 2>&1 | head -n 3 | tr "\n" " "; echo; done'
echo "=== SRS 自己的日志（最近）==="
docker logs --since 10m hn-srs 2>&1 | tail -n 8 | cut -c1-260
echo "=== hn-srs 在内网里解析成什么；SRS 容器的地址 ==="
docker exec hn-nginx sh -c 'getent hosts hn-srs'
docker inspect hn-srs --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{end}}'
echo "=== 后端容器里跑的是不是新代码 ==="
docker exec hn-api sh -c 'grep -c "apiPort === 443" dist/src/srs/srs.service.js; printenv SRS_API'
echo "=== 域名下 /api/v1/versions 返回的是谁的（SRS 的会带 \"server\" 和版本号）==="
curl -s -m 10 https://gphnai.com/api/v1/versions | head -c 160; echo
