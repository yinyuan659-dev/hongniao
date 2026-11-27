# 实测「聊天放开、视频要互相喜欢」之前：两个测试号（女 997353、男 711405）现在是互相喜欢的，没法测「没互相喜欢」的情况。
# 这里只动这两个测试号之间的那两条喜欢记录：先把原样存成一份还原用的 SQL，再把「女 → 男」那条改成没喜欢
#（改完：男的看是「我喜欢了，对方没回应」，女的看是「对方先喜欢了我」）。测完跑 openchat_test_restore.sh 改回去。
# 不碰别的账号、别的表，不改表结构。
cd /opt/hongniang
SAVE=backup/openchat-test-rows.sql
sql() { docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" hongniang -N 2>/dev/null'; }
if [ -s "$SAVE" ]; then
  echo "还原用的 SQL 已经有了（上次测完没还原？），不覆盖：$SAVE"
else
  sql > "$SAVE" <<'SQL'
SET @f := (SELECT id FROM user WHERE short_id='997353');
SET @m := (SELECT id FROM user WHERE short_id='711405');
SELECT CONCAT('UPDATE match_action SET kind=', QUOTE(kind), ', liked_at=', IFNULL(QUOTE(liked_at), 'NULL'), ', matched_at=', IFNULL(QUOTE(matched_at), 'NULL'),
              ', seen=', seen, ', match_seen=', match_seen, ', updated_at=', QUOTE(updated_at), ' WHERE id=', id, ';')
FROM match_action WHERE (user_id=@f AND target_id=@m) OR (user_id=@m AND target_id=@f);
SQL
  chmod 600 "$SAVE"
  echo "saved: $SAVE ($(wc -l < "$SAVE") rows)"
fi
cat "$SAVE" | sed -E 's/(liked_at|matched_at|updated_at)=[^,;]*/\1=…/g'
sql <<'SQL'
SET @f := (SELECT id FROM user WHERE short_id='997353');
SET @m := (SELECT id FROM user WHERE short_id='711405');
UPDATE match_action SET kind='none' WHERE user_id=@f AND target_id=@m AND kind='like';
SELECT 'now', IF(user_id=@f, 'female->male', 'male->female'), kind FROM match_action WHERE (user_id=@f AND target_id=@m) OR (user_id=@m AND target_id=@f);
SELECT 'allow_video / real_status', short_id, allow_video, real_status FROM user WHERE id IN (@f, @m);
SQL
