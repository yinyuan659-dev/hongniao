import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { wsManager } from '../ws';
import { Ic, Nav, useBack, useToast } from '../hn';
import { ReportSheet } from '../components/MsgActions';
import { GROUP_END_TEXT, GroupAvatar, GroupEvent, GroupMemberView, GroupView, KindTag, OwnerBadge, ownerLabel, stateAfter } from '../group';
import '../hn.css';

/** 成员先显示两行（一行 5 个），多了点「全部」展开 */
const FOLD = 10;

/**
 * 群资料（样稿 design/12-group.html 第 2 组，用户 2026-11-27 过关）。
 * 普通成员：成员、群公告（只能看）、消息免打扰、举报这个群、退出群聊。
 * 群主（线路群是领队，活动群是发起人）：多了改群名、写群公告、移出成员；最下面是「解散群聊」。群主不能退群、不能转让、不能拉人。
 * 页面上的内容靠推送（op: 'group'）更新：有人进出、群名公告改了、解散了，不用刷新。
 */
export function GroupInfoPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const back = useBack();
  const me = useApp((s) => s.user);
  const meRef = useRef(me);
  meRef.current = me;
  const [toast, showToast] = useToast();
  const [g, setG] = useState<GroupView | null>(null);
  const [err, setErr] = useState('');
  const [all, setAll] = useState(false);
  /** 群主点了「移出」：成员头像上出现红色的减号，点谁移出谁 */
  const [removing, setRemoving] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; ok: string; run: () => Promise<void> } | null>(null);
  const [edit, setEdit] = useState<{ field: 'name' | 'notice'; value: string } | null>(null);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!id) return;
    api<GroupView>(`/im/group/${id}`).then((v) => { setG(v); setErr(''); }).catch((e: any) => setErr(e.message || '打不开这个群'));
  };

  useEffect(() => {
    load();
    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'ws_reopen') return load();
      if (frame.op !== 'group') return;
      const ev = frame.data as GroupEvent;
      if (ev.groupId !== id) return;
      const myId = meRef.current?.id;
      // 群名、公告、人数、解散 / 关闭：推送里直接带着，马上改
      setG((prev) => (prev ? { ...prev, ...ev.group, state: stateAfter(ev, myId, prev.state), role: prev.role, muted: prev.muted, members: prev.members } : prev));
      // 有人退了 / 被移出了：从名单里拿掉；我自己不在了：名单清空
      if ((ev.event === 'leave' || ev.event === 'kick') && ev.userId) {
        setG((prev) => (prev ? { ...prev, members: ev.userId === myId ? [] : prev.members.filter((m) => m.id !== ev.userId) } : prev));
      }
      // 有人进群：推送里只有 id 和昵称，头像要重新拿一次名单
      if (ev.event === 'join') load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!g) {
    return (
      <div className="hn-page">
        <Nav title="群资料" onBack={back} />
        <div className="hn-t2" style={{ textAlign: 'center', padding: '80px 20px' }}>{err || '加载中…'}</div>
      </div>
    );
  }

  const owner = g.role === 'owner';
  const gone = g.state !== 'ok';
  const shown = all ? g.members : g.members.slice(0, FOLD);
  const ownerName = g.members.find((m) => m.role === 'owner')?.nickname;

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (done) showToast(done);
    } catch (e: any) {
      showToast(e.message || '操作失败');
    }
    setBusy(false);
  };

  const kick = (m: GroupMemberView) => setConfirm({
    title: `把 ${m.nickname} 移出群聊？`,
    body: '移出以后，TA 不能自己再进这个群。',
    ok: '移出',
    run: () => act(async () => {
      await api(`/im/group/${g.id}/kick`, { method: 'POST', body: { userId: m.id } });
      // 人数、名单以服务器为准：正常情况下推送已经先到了；这里再拿一次，推送万一没到也不会错
      setG((prev) => (prev ? { ...prev, members: prev.members.filter((x) => x.id !== m.id) } : prev));
      load();
    }, `已把 ${m.nickname} 移出`),
  });

  const leave = () => setConfirm({
    title: '退出群聊？',
    body: '退出以后不会再收到这个群的消息。之后还想进，回到线路 / 活动页重新点「约单 / 参与」。',
    ok: '退出',
    run: () => act(async () => {
      await api(`/im/group/${g.id}/leave`, { method: 'POST' });
      nav('/chat', { replace: true });
    }),
  });

  const dissolve = () => setConfirm({
    title: '解散群聊？',
    body: '解散以后所有人都不能再发消息，之前的聊天记录还能看。解散了不能恢复。',
    ok: '解散',
    run: () => act(async () => {
      await api(`/im/group/${g.id}/dissolve`, { method: 'POST' });
      load();
    }, '群聊已解散'),
  });

  const saveEdit = () => {
    if (!edit) return;
    const { field, value } = edit;
    void act(async () => {
      const v = await api<GroupView>(`/im/group/${g.id}/update`, { method: 'POST', body: { [field]: value } });
      setG(v);
      setEdit(null);
    }, field === 'name' ? '群名已修改' : '群公告已更新');
  };

  const card: React.CSSProperties = { margin: '10px 16px 0', background: '#fff', borderRadius: 18, padding: '13px 15px', boxShadow: '0 4px 16px rgba(43, 28, 34, 0.05)' };
  const rowl: React.CSSProperties = { display: 'flex', alignItems: 'center', minHeight: 50, padding: '0 15px', fontSize: 14.5, gap: 10 };
  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      {toast}
      <Nav title="群资料" onBack={back} />
      <div className="hn-scroll" style={{ paddingBottom: 'calc(28px + env(safe-area-inset-bottom))' }}>
        <div style={{ ...card, marginTop: 2 }}>
          <div className="hn-row">
            <GroupAvatar g={g} size={52} />
            <div className="hn-grow">
              <b style={{ fontSize: 16, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</b>
              <div className="hn-t2" style={{ marginTop: 3, fontSize: 12.5 }}>
                {gone ? GROUP_END_TEXT[g.state as Exclude<GroupView['state'], 'ok'>] : `${g.memberCount} 人 · ${owner ? `我是${ownerLabel(g.kind)}` : `${ownerLabel(g.kind)}${ownerName ? ` ${ownerName}` : ''}`}`}
              </div>
            </div>
            <KindTag kind={g.kind} />
          </div>
        </div>

        {g.members.length > 0 && (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 800 }}>
              群成员
              {g.members.length > FOLD && (
                <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 500, color: 'var(--hn-ink3)', cursor: 'pointer' }} onClick={() => setAll((v) => !v)}>
                  {all ? '收起' : `全部 ${g.memberCount} 人 ›`}
                </span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '14px 2px', marginTop: 12 }}>
              {shown.map((m) => {
                const canKick = removing && m.role !== 'owner';
                return (
                  <div
                    key={m.id}
                    style={{ textAlign: 'center', fontSize: 11, color: 'var(--hn-ink2)', cursor: 'pointer', minWidth: 0 }}
                    onClick={() => (canKick ? kick(m) : removing ? undefined : nav(`/u/${m.id}`))}
                  >
                    <div style={{ width: 44, height: 44, borderRadius: 22, margin: '0 auto 7px', position: 'relative', border: '2px solid #fff', boxShadow: '0 2px 8px rgba(43, 28, 34, 0.1)', background: `#e9e1e3 center / cover${m.avatar ? ` url(${m.avatar})` : ''}`, opacity: removing && !canKick ? 0.45 : 1 }}>
                      {m.role === 'owner' && <OwnerBadge kind={g.kind} style={{ position: 'absolute', left: '50%', bottom: -8, transform: 'translateX(-50%)', margin: 0, border: '1.5px solid #fff' }} />}
                      {canKick && (
                        <span style={{ position: 'absolute', right: -5, top: -5, width: 18, height: 18, borderRadius: 9, background: '#f04438', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #fff', fontSize: 14, lineHeight: 1, fontWeight: 700 }}>−</span>
                      )}
                    </div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 2px' }}>{m.id === me?.id ? '我' : m.nickname}</div>
                  </div>
                );
              })}
              {owner && !gone && g.members.length > 1 && (
                <div data-act="kick-mode" style={{ textAlign: 'center', fontSize: 11, color: '#f04438', cursor: 'pointer' }} onClick={() => { setRemoving((v) => !v); setAll(true); }}>
                  <div style={{ width: 44, height: 44, borderRadius: 22, margin: '0 auto 7px', border: '1.5px dashed #f7a8a2', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f04438', fontSize: 22, lineHeight: 1 }}>{removing ? <Ic n="check" s={18} /> : '−'}</div>
                  {removing ? '完成' : '移出'}
                </div>
              )}
            </div>
            {removing && <div className="hn-t3" style={{ marginTop: 10, textAlign: 'center' }}>点要移出的人。被移出的人不能自己再进这个群。</div>}
          </div>
        )}

        {(g.notice || (owner && !gone)) && (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 800 }}>
              群公告
              {owner && !gone && <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--hn-rose)', fontWeight: 700, cursor: 'pointer' }} onClick={() => setEdit({ field: 'notice', value: g.notice })}>编辑</span>}
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.7, color: g.notice ? '#4b3d43' : 'var(--hn-ink3)', marginTop: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{g.notice || '还没有写群公告'}</p>
          </div>
        )}

        {!gone && (
          <div style={{ ...card, padding: 0 }}>
            {owner && (
              <div style={{ ...rowl, cursor: 'pointer', borderBottom: '1px solid var(--hn-line)' }} onClick={() => setEdit({ field: 'name', value: g.name })}>
                群名
                <span style={{ marginLeft: 'auto', color: 'var(--hn-ink3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>{g.name}</span><Ic n="right" s={15} />
                </span>
              </div>
            )}
            <div style={rowl}>
              消息免打扰
              <span
                className={`hn-switch${g.muted ? ' on' : ''}`}
                style={{ marginLeft: 'auto' }}
                onClick={() => act(async () => {
                  const r = await api<{ muted: boolean }>(`/im/group/${g.id}/mute`, { method: 'POST', body: { muted: !g.muted } });
                  setG((prev) => (prev ? { ...prev, muted: r.muted } : prev));
                })}
              />
            </div>
            {!owner && (
              <div style={{ ...rowl, cursor: 'pointer', borderTop: '1px solid var(--hn-line)' }} onClick={() => setReporting(true)}>
                举报这个群<span style={{ marginLeft: 'auto', color: 'var(--hn-ink3)', display: 'flex' }}><Ic n="right" s={15} /></span>
              </div>
            )}
          </div>
        )}

        {/* 最下面那个红字按钮：成员是「退出群聊」，群主是「解散群聊」；群已经用不了的（解散了 / 被关闭 / 我不在了）是「从消息列表里删除」 */}
        <div
          style={{ margin: '12px 16px 0', height: 48, borderRadius: 18, background: '#fff', color: '#f04438', fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(43, 28, 34, 0.05)', cursor: 'pointer' }}
          onClick={() => {
            if (!gone) return owner ? dissolve() : leave();
            setConfirm({
              title: '从消息列表里删除？',
              body: '只是从你自己的消息列表里删掉，删了以后这个群的聊天记录就看不到了。',
              ok: '删除',
              run: () => act(async () => {
                await api(`/im/group/${g.id}/hide`, { method: 'POST' });
                nav('/chat', { replace: true });
              }),
            });
          }}
        >
          {gone ? '从消息列表里删除' : owner ? '解散群聊' : '退出群聊'}
        </div>
        {!gone && !owner && g.state === 'ok' && (
          <div className="hn-t3" style={{ textAlign: 'center', marginTop: 12, lineHeight: 1.7, padding: '0 24px' }}>线下见面前不要转账；遇到借钱、投资、推销的，直接举报。</div>
        )}
      </div>

      {confirm && (
        <div className="hn-dim center" onClick={() => setConfirm(null)}>
          <div className="hn-dialog" style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>{confirm.title}</div>
            <div className="hn-t2" style={{ fontSize: 13.5, lineHeight: 1.65, marginTop: 8 }}>{confirm.body}</div>
            <div className="hn-row" style={{ marginTop: 16 }}>
              <button className="hn-btn flat" style={{ height: 44, fontSize: 14.5 }} onClick={() => setConfirm(null)}>取消</button>
              <button className="hn-btn" style={{ height: 44, fontSize: 14.5 }} onClick={() => { const c = confirm; setConfirm(null); void c.run(); }}>{confirm.ok}</button>
            </div>
          </div>
        </div>
      )}

      {edit && (
        <div className="hn-dim center" onClick={() => setEdit(null)}>
          <div className="hn-dialog" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>{edit.field === 'name' ? '修改群名' : '群公告'}</div>
            {edit.field === 'name' ? (
              <div className="hn-field" style={{ marginTop: 12, boxShadow: 'none', background: '#faf6f6' }}>
                <input autoFocus maxLength={30} value={edit.value} placeholder="群名（最多 30 个字）" onChange={(e) => setEdit({ field: 'name', value: e.target.value })} />
              </div>
            ) : (
              <textarea autoFocus maxLength={500} value={edit.value} placeholder="集合时间地点、要带什么、注意事项…（最多 500 个字）" style={{ minHeight: 130 }} onChange={(e) => setEdit({ field: 'notice', value: e.target.value })} />
            )}
            <div className="hn-row" style={{ marginTop: 14 }}>
              <button className="hn-btn flat" style={{ height: 44, fontSize: 14.5 }} onClick={() => setEdit(null)}>取消</button>
              <button className="hn-btn" style={{ height: 44, fontSize: 14.5 }} disabled={busy || (edit.field === 'name' && !edit.value.trim())} onClick={saveEdit}>保存</button>
            </div>
          </div>
        </div>
      )}

      {reporting && <ReportSheet groupId={g.id} onClose={() => setReporting(false)} onDone={(tip) => { setReporting(false); showToast(tip); }} />}
    </div>
  );
}
