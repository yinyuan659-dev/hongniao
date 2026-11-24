set -e
cd /opt/hongniang
docker compose up -d --build api < /dev/null
echo "=== compose up done ==="
