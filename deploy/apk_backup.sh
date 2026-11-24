cd /opt/hongniang
# 覆盖安卓测试包之前，把现在的那个留一份（putdir 会先清空 www/app，所以放到 backup/ 里）
mkdir -p backup
if [ -f www/app/hongniang-test.apk ]; then
  cp -p www/app/hongniang-test.apk backup/hongniang-test-prev.apk
  echo "prev apk kept: $(stat -c '%s bytes' backup/hongniang-test-prev.apk) sha256=$(sha256sum backup/hongniang-test-prev.apk | cut -c1-16)…"
else
  echo "no apk on server yet"
fi
