# 实测完「聊天放开、视频要互相喜欢」之后：把两个测试号（女 997353、男 711405）之间的喜欢记录改回 openchat_test_prep.sh 存下来的原样（互相喜欢），
# 并把「视频见面要互相喜欢」这个开关的状态打印出来核对（应该是打开的）。只动这两个测试号之间的记录。
cd /opt/hongniang
SAVE=backup/openchat-test-rows.sql
sql() { docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N 2>/dev/null'; }
[ -s "$SAVE" ] || { echo "没有还原用的 SQL（$SAVE），没有动任何东西"; exit 1; }
grep -c '^UPDATE match_action SET kind=' "$SAVE"
grep -vq '^UPDATE match_action SET kind=.* WHERE id=[0-9]*;$' "$SAVE" && { echo "还原文件里有不认识的行，停"; exit 1; }
sql < "$SAVE"
sql <<'SQL'
SET @f := (SELECT id FROM user WHERE short_id='997353');
SET @m := (SELECT id FROM user WHERE short_id='711405');
SELECT 'restored', IF(user_id=@f, 'female->male', 'male->female'), kind, IF(matched_at IS NULL, 'no matched_at', 'has matched_at') FROM match_action WHERE (user_id=@f AND target_id=@m) OR (user_id=@m AND target_id=@f);
SELECT 'switch (空 = 没设置过 = 打开)', `key`, value FROM sys_setting WHERE `key`='match_video_need_like';
SQL
mv "$SAVE" "backup/openchat-test-rows-restored-$(date +%Y%m%d-%H%M%S).sql"
echo "done"
