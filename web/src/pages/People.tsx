import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { t } from '../i18n';
import { LikePill, RelState } from '../match';

interface PersonItem {
  id: string;
  /** 我和 TA 的喜欢关系（遇见列表接口带的） */
  like?: RelState;
  nickname: string;
  avatar: string;
  age: number;
  cityName: string;
  signature: string;
  isGuide: boolean;
  albums?: { id: string; type: number; url: string; coverUrl: string }[];
}

/** 找人 */
export function PeoplePage() {
  const nav = useNavigate();
  const [items, setItems] = useState<PersonItem[]>([]);

  useEffect(() => {
    api<PersonItem[]>('/user/meet/list').then(setItems).catch(() => {});
  }, []);

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹ {t('common.back')}</span>
        <span className="title">{t('hall.findPeople')}</span>
        <span style={{ width: 40 }} />
      </div>
      <div className="page">
        {items.length === 0 && <div className="empty">{t('people.noUsers')}</div>}
        {items.map((p) => (
          <div key={p.id} className="card" style={{ margin: '0 16px 8px' }}>
            <div className="row">
              <div className="avatar" style={{ width: 56, height: 56 }}>
                {p.avatar && <img src={p.avatar} alt="" />}
              </div>
              <div className="grow">
                <div style={{ fontSize: 15 }}>
                  {p.nickname} <span className="muted">· {p.age}</span>
                  {p.isGuide && <span className="tag tag-accent" style={{ marginLeft: 6 }}>{t('me.verified')}</span>}
                </div>
                <div className="muted ellipsis" style={{ marginTop: 4 }}>{p.signature || t('people.mysterious')}</div>
                {p.cityName && <div className="small" style={{ marginTop: 2 }}>{p.cityName}</div>}
              </div>
              {/* 列表上只放喜欢按钮；发消息点头像进画像页（2026-11-27 起不用互相喜欢） */}
              <LikePill peer={p} initial={p.like ?? 'none'} />
            </div>
            {p.albums && p.albums.length > 0 && (
              <div className="grid-photos">
                {p.albums.slice(0, 3).map((a) => (
                  <img key={a.id} src={a.type === 2 ? a.coverUrl : a.url} alt="" />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
