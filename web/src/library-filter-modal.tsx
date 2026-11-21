import { useDeferredValue, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { CalendarDays, Check, Disc3, FileAudio, Music2, RotateCcw } from 'lucide-react';
import { Modal } from './components';
import { EMPTY_FILTERS, filterCount, filterError, matchesFilters, RANGE_FILTERS, TEXT_FILTERS, type LibraryFilters } from './library-filters';
import type { Track } from './types';
import { matches, normalize } from './utils';

function Choice({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <fieldset className="library-filter-field"><legend>{label}</legend><div className="library-filter-choices">
    {options.map(([key, text]) => <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>)}
  </div></fieldset>;
}

export function LibraryFilterModal({ value, tracks, query, onApply, onClose }: { value: LibraryFilters; tracks: Track[]; query: string; onApply: (value: LibraryFilters) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  const deferredDraft = useDeferredValue(draft);
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement;
    formRef.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  function update(key: keyof LibraryFilters, next: string) { setDraft(old => ({ ...old, [key]: next })); }
  const error = filterError(draft);
  const count = filterCount(draft);
  const matched = tracks.filter(track => matches(track, query) && matchesFilters(track, deferredDraft)).length;
  const tags = [...new Set(tracks.flatMap(track => track.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  function selectField(key: 'tag' | 'format' | 'sampleRate' | 'bitDepth' | 'channels', label: string, options: [string, string][]) {
    return <label className="library-filter-field"><span>{label}</span><select aria-label={label} value={draft[key]} onChange={event => update(key, event.target.value)}>
      <option value="">不限</option>
      {draft[key] && !options.some(([value]) => value === draft[key]) && <option value={draft[key]}>{key === 'format' ? draft[key].toUpperCase() : draft[key]}</option>}
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select></label>;
  }

  function numericOptions(key: 'sampleRate' | 'bitDepth' | 'channels', format: (value: number) => string): [string, string][] {
    return [...new Set(tracks.map(track => track[key]).filter(value => value > 0))].sort((a, b) => a - b).map(value => [String(value), format(value)]);
  }

  return <Modal title="筛选音乐" className="library-filter-modal" onClose={onClose}><form ref={formRef} tabIndex={-1} onSubmit={event => {
    event.preventDefault();
    if (!error) {
      const applied = { ...draft };
      for (const { key } of TEXT_FILTERS) applied[key] = applied[key].trim();
      onApply(applied); onClose();
    }
  }}>
    <div className="library-filter-content">
      <section className="library-filter-section"><h3><Music2 size={16} />曲目信息</h3><div className="library-filter-grid">
        {TEXT_FILTERS.map(({ key, label }) => {
          const options = key === 'title' ? [] : [...new Set(tracks.flatMap(track => key === 'artist' || key === 'albumArtist' ? (track[key] || '').split('/') : [track[key] || '']).map(value => value.trim()).filter(Boolean))]
            .filter(value => normalize(value).includes(normalize(draft[key].trim()))).sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, 50);
          return <label className="library-filter-field" key={key}><span>{label}</span><input value={draft[key]} placeholder="不限" list={key === 'title' ? undefined : `${id}-${key}`} onChange={event => update(key, event.target.value)} />
            {key !== 'title' && <datalist id={`${id}-${key}`}>{options.map(value => <option key={value} value={value} />)}</datalist>}
          </label>;
        })}
        {selectField('tag', '标签', tags.map(tag => [tag, tag]))}
      </div></section>
      <section className="library-filter-section"><h3><CalendarDays size={16} />年份与节奏</h3><div className="library-filter-grid">
        {RANGE_FILTERS.map(({ label, from, to, unit, step }) => <fieldset className="library-filter-field library-filter-range" key={from}><legend>{label}<small>{unit}</small></legend><div>
          <input type="number" aria-label={`${label}最小值`} min={0} step={step} placeholder="最小值" value={draft[from]} onChange={event => update(from, event.target.value)} />
          <span>至</span>
          <input type="number" aria-label={`${label}最大值`} min={0} step={step} placeholder="最大值" value={draft[to]} onChange={event => update(to, event.target.value)} />
        </div></fieldset>)}
      </div></section>
      <section className="library-filter-section"><h3><FileAudio size={16} />音频规格</h3><div className="library-filter-grid">
        {selectField('format', '音频编码', [...new Set(tracks.map(track => normalize(track.format || '')).filter(Boolean))].sort().map(value => [value, value.toUpperCase()]))}
        {selectField('sampleRate', '采样率', numericOptions('sampleRate', value => `${value / 1000} kHz`))}
        {selectField('bitDepth', '位深', numericOptions('bitDepth', value => `${value} bit`))}
        {selectField('channels', '声道', numericOptions('channels', value => value === 1 ? '单声道' : value === 2 ? '立体声' : `${value} 声道`))}
      </div></section>
      <section className="library-filter-section"><h3><Disc3 size={16} />资料状态</h3><div className="library-filter-grid">
        <Choice label="收藏" value={draft.favorite} options={[["", "不限"], ["yes", "已收藏"], ["no", "未收藏"]]} onChange={value => update('favorite', value)} />
        <Choice label="歌词" value={draft.lyrics} options={[["", "不限"], ["yes", "有歌词"], ["no", "无歌词"]]} onChange={value => update('lyrics', value)} />
        <Choice label="封面" value={draft.cover} options={[["", "不限"], ["yes", "有封面"], ["no", "无封面"]]} onChange={value => update('cover', value)} />
      </div></section>
    </div>
    <footer className="modal-footer library-filter-footer">
      <div className="library-filter-summary" role="status" aria-live="polite" aria-busy={draft !== deferredDraft}>{error ? <span className="error-text">{error}</span> : <><strong>{matched} 首匹配</strong><span>{count ? `${count} 项条件` : '不限条件'}</span></>}</div>
      <div className="library-filter-actions"><button type="button" className="text-button library-filter-reset" onClick={() => setDraft({ ...EMPTY_FILTERS })}><RotateCcw size={14} />重置</button><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={!!error}><Check size={15} />应用筛选</button></div>
    </footer>
  </form></Modal>;
}
