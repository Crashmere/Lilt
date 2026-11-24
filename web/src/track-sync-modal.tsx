import { useEffect, useState } from 'react';
import { ArrowRightLeft, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError, json, messageOf, request } from './api';
import { Artwork, Modal } from './components';
import type { Track } from './types';
import './track-sync.css';

export type TrackPair = readonly [Track, Track];
const metadataFields = [
  ['title', '曲名'], ['artist', '艺术家'], ['album', '专辑'], ['albumArtist', '专辑艺术家'],
  ['version', '版本'], ['genre', '风格'], ['year', '年份'], ['trackNumber', '曲序'],
  ['discNumber', '碟号'], ['bpm', 'BPM'], ['composer', '作曲'], ['lyricist', '作词'],
  ['copyright', '版权'], ['isrc', 'ISRC'], ['comment', '备注'], ['tags', '标签'], ['aliases', '搜索别名'],
] as const;
const syncFields = [...metadataFields, ['cover', '封面'], ['lyricsText', '歌词']] as const;
type SyncField = typeof syncFields[number][0];

function fieldText(track: Track, field: SyncField): string {
  if (field === 'cover') return track.coverUrl ? '有封面' : '';
  const value = track[field];
  return Array.isArray(value) ? value.join('、') : value ? String(value).trim() : '';
}

export function TrackSyncModal({ tracks, onClose, onSaved }: { tracks: TrackPair; onClose: () => void; onSaved: (track: Track) => void }) {
  const [details, setDetails] = useState<TrackPair>();
  const [direction, setDirection] = useState(0);
  const [selected, setSelected] = useState<Set<SyncField>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [reload, setReload] = useState(0);
  const [firstID, secondID] = tracks.map(track => track.id);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    void Promise.all([firstID, secondID].map(id => request<{ track: Track }>(`/tracks/${encodeURIComponent(id)}`, { signal: abort.signal })))
      .then(([first, second]) => { setDetails([first.track, second.track]); setStale(false); })
      .catch(error => { if (!abort.signal.aborted) setError(messageOf(error)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [firstID, secondID, reload]);
  const pair = details || tracks;
  const source = pair[direction];
  const target = pair[1 - direction];
  const disabled = busy || loading || !details || stale;
  const clearing = syncFields.filter(([field]) => selected.has(field) && !fieldText(source, field) && fieldText(target, field)).map(([, label]) => label);
  function close() { if (!busy) onClose(); }
  function toggle(field: SyncField) {
    setSelected(old => { const next = new Set(old); if (next.has(field)) next.delete(field); else next.add(field); return next; });
  }
  async function save() {
    if (disabled || !selected.size) return;
    setBusy(true); setError('');
    try {
      const result = await json<{ track: Track }>(`/tracks/${encodeURIComponent(target.id)}/sync`, 'POST', {
        sourceId: source.id, fields: [...selected], expectedSourceUpdatedAt: source.updatedAt, expectedUpdatedAt: target.updatedAt,
      });
      onSaved(result.track); onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setStale(true);
      setError(messageOf(error));
    } finally { setBusy(false); }
  }
  return <Modal title="同步歌曲信息" className="track-sync-modal" onClose={close}><form onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="modal-body track-sync-body">
      <div className="track-sync-direction">
        {[source, target].map((track, index) => <div className={`track-sync-card ${index === 0 ? 'source' : ''}`} key={index}>
          <span className="track-sync-role">{index === 0 ? '来源' : '目标'}</span>
          <div><Artwork url={track.coverUrl} title={track.title} /><div><strong title={track.title}>{track.title}</strong><p>{track.artist}{track.version ? ` · ${track.version}` : ''}</p></div></div>
          <small title={track.originalName}>{track.originalName}</small>
        </div>)}
        <button className="icon-button track-sync-swap" type="button" disabled={busy || loading} aria-label="交换同步方向" title="交换同步方向" onClick={() => setDirection(old => 1 - old)}><ArrowRightLeft size={19} /></button>
      </div>
      {loading && <p className="track-sync-status" role="status"><LoaderCircle size={16} className="spin" />正在读取歌曲信息…</p>}
      <fieldset disabled={disabled}>
        <div className="track-sync-toolbar"><h3>同步内容</h3><button type="button" className="text-button" onClick={() => setSelected(new Set(syncFields.map(([field]) => field)))}>全选</button><button type="button" className="text-button" onClick={() => setSelected(new Set())}>清空选择</button></div>
        <div className="track-sync-columns"><span>字段</span><span>来源值</span><span>目标当前值</span></div>
        {syncFields.map(([field, label]) => <label className={`track-sync-field ${selected.has(field) ? 'selected' : ''}`} key={field}>
          <span className="track-sync-field-name"><input type="checkbox" aria-label={`同步${label}`} checked={selected.has(field)} onChange={() => toggle(field)} />{label}</span>
          {[source, target].map((track, index) => <span className={`track-sync-value ${!fieldText(track, field) ? 'empty' : ''}`} key={index} title={fieldText(track, field)}>
            {field === 'cover' && track.coverUrl ? <Artwork url={track.coverUrl} title={`${index === 0 ? '来源' : '目标'}封面`} /> : fieldText(track, field) || (index === 0 ? '空值' : '未设置')}
          </span>)}
        </label>)}
      </fieldset>
    </div>
    {(clearing.length > 0 || error) && <div className="track-sync-notices">
      {clearing.length > 0 && <p className="track-sync-warning">来源为空，将清空目标的{clearing.join('、')}。</p>}
      {error && <div className="track-sync-error"><p className="error-text" role="alert">{error}</p><button className="text-button" type="button" disabled={busy || loading} onClick={() => setReload(old => old + 1)}><RefreshCw size={14} />重新载入</button></div>}
    </div>}
    <footer className="modal-footer"><span>仅覆盖勾选内容{selected.size > 0 ? ` · ${selected.size} 项` : ''}</span><div className="editor-footer-actions"><button className="button secondary" type="button" disabled={busy} onClick={close}>取消</button><button className="button primary" type="submit" disabled={disabled || !selected.size}>{busy ? '同步中…' : '同步并写回'}</button></div></footer>
  </form></Modal>;
}
