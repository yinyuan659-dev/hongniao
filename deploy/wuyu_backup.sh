# 部署大厅两张卡 + 相亲物语之前：把服务器上现在的网页留一份，出问题能直接换回去
set -e
cd /opt/hongniang
mkdir -p backup
rm -rf backup/web-prev
cp -a www/web backup/web-prev
echo "backup/web-prev: $(find backup/web-prev -type f | wc -l) files"
grep -o 'assets/[A-Za-z0-9_-]*\.js' backup/web-prev/index.html | head -3
