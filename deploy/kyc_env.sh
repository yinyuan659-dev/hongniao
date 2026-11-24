set -e
cd /opt/hongniang
test -f kyc.env.tmp
cp -p .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
grep -v '^KYC_' .env > .env.new || true
# 原文件最后一行没换行的话先补一个，免得新加的第一行接在它后面
if [ -n "$(tail -c1 .env.new)" ]; then echo >> .env.new; fi
cat kyc.env.tmp >> .env.new
chmod 600 .env.new
mv .env.new .env
rm -f kyc.env.tmp
echo "=== KYC_ keys in .env now (name + value length, no values) ==="
awk -F= '/^KYC_/{print $1" len="length($2)}' .env
echo "=== .env perms / line count ==="
stat -c '%a %n' .env
wc -l < .env
echo "=== done ==="
