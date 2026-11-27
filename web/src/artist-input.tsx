import { Check, Copy, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Artist } from './types';
import { normalize } from './utils';

export const DEFAULT_ARTIST = '未知歌手';

export function splitArtists(value: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split('/')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

export function joinArtists(names: readonly string[]): string {
  return names.map(name => name.trim()).filter(Boolean).join(' / ');
}

export function mergeArtists(current: readonly string[], input: string): string[] {
  const seen = new Set(current.map(name => name.toLocaleLowerCase()));
  const next = [...current];
  for (const name of splitArtists(input)) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(name);
  }
  return next;
}

export type ArtistInputProps = {
  id?: string;
  ariaLabel: string;
  values: string[];
  draft: string;
  artists: Artist[];
  disabled?: boolean;
  placeholder?: string;
  onChangeValues: (next: string[]) => void;
  onChangeDraft: (next: string) => void;
};

type PointerDrag = {
  from: number;
  name: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  over: number;
  position: 'before' | 'after';
};
type DropdownPosition = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

export function ArtistInput({ id, ariaLabel, values, draft, artists, disabled = false, placeholder, onChangeValues, onChangeDraft }: ArtistInputProps) {
  const instanceId = useId();
  const listboxId = `${instanceId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const onChangeValuesRef = useRef(onChangeValues);
  onChangeValuesRef.current = onChangeValues;
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [drag, setDrag] = useState<PointerDrag | null>(null);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    clearTimeout(copiedTimerRef.current);
    dragCleanupRef.current?.();
  }, []);

  const trimmed = draft.trim();
  const normQuery = normalize(trimmed);
  const terms = normQuery.split(/\s+/).filter(Boolean);
  const selected = new Set(values.map(value => value.toLocaleLowerCase()));

  const matches = (() => {
    if (!trimmed) return [];
    const tiers: Artist[][] = [[], [], [], []];
    for (const artist of artists) {
      if (artist.name === DEFAULT_ARTIST || selected.has(artist.name.toLocaleLowerCase())) continue;
      const normName = normalize(artist.name);
      const normSearch = normalize(artist.searchText || '');
      const haystack = `${normName} ${normSearch}`;
      if (!terms.every(term => haystack.includes(term))) continue;
      const tier = normName === normQuery ? 0 : normName.startsWith(normQuery) ? 1 : normName.includes(normQuery) ? 2 : 3;
      tiers[tier].push(artist);
    }
    return [...tiers[0], ...tiers[1], ...tiers[2], ...tiers[3]].slice(0, 30);
  })();

  const showDropdown = !disabled && open && trimmed.length > 0 && matches.length > 0;

  useLayoutEffect(() => {
    if (!showDropdown || !containerRef.current) {
      setPosition(null);
      return;
    }
    const update = () => {
      const box = containerRef.current;
      if (!box) return;
      const rect = box.getBoundingClientRect();
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 10);
      const spaceAbove = Math.max(0, rect.top - 10);
      if (spaceBelow < 150 && spaceAbove > spaceBelow) {
        setPosition({ left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 5, maxHeight: Math.min(232, spaceAbove) });
      } else {
        setPosition({ left: rect.left, width: rect.width, top: rect.bottom + 5, maxHeight: Math.min(232, spaceBelow) });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [showDropdown, values.length, draft]);

  useEffect(() => {
    if (!showDropdown) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (containerRef.current?.contains(target) || dropdownRef.current?.contains(target))) return;
      setOpen(false);
      setActiveIndex(-1);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [showDropdown]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onNativeKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        return;
      }
      if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!showDropdown) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActiveIndex(-1);
    };
    input.addEventListener('keydown', onNativeKeyDown);
    return () => input.removeEventListener('keydown', onNativeKeyDown);
  }, [showDropdown]);

  useEffect(() => {
    if (!showDropdown || activeIndex < 0) return;
    const option = dropdownRef.current?.children[activeIndex] as HTMLElement | undefined;
    option?.scrollIntoView({ block: 'nearest' });
  }, [showDropdown, activeIndex]);

  function removeAt(index: number) {
    if (disabled) return;
    onChangeValues(values.filter((_, i) => i !== index));
  }

  function selectArtist(name: string) {
    if (disabled) return;
    onChangeValues(mergeArtists(values, name));
    onChangeDraft('');
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function commitDraft() {
    if (disabled || !trimmed) return;
    onChangeValues(mergeArtists(values, draft));
    onChangeDraft('');
    setOpen(false);
    setActiveIndex(-1);
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (showDropdown && activeIndex >= 0 && activeIndex < matches.length) {
        selectArtist(matches[activeIndex].name);
      } else {
        commitDraft();
      }
      return;
    }
    if (event.key === 'ArrowDown' && showDropdown) {
      event.preventDefault();
      setActiveIndex(old => old < matches.length - 1 ? old + 1 : 0);
      return;
    }
    if (event.key === 'ArrowUp' && showDropdown) {
      event.preventDefault();
      setActiveIndex(old => old <= 0 ? matches.length - 1 : old - 1);
      return;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (showDropdown) {
        event.preventDefault();
        setActiveIndex(old => event.shiftKey ? (old <= 0 ? matches.length - 1 : old - 1) : (old < matches.length - 1 ? old + 1 : 0));
      }
      return;
    }
    if (event.key === 'Backspace' && draft === '' && values.length > 0 && !disabled) {
      event.preventDefault();
      onChangeValues(values.slice(0, -1));
    }
  }

  function onInputPaste(event: ClipboardEvent<HTMLInputElement>) {
    if (disabled) return;
    const pasted = event.clipboardData?.getData('text/plain') || '';
    if (!pasted) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? draft.length;
    const combined = draft.slice(0, start) + pasted + draft.slice(end);
    if (!/[\/\r\n]/.test(combined)) return;
    event.preventDefault();
    const normalized = combined.replace(/[\r\n]+/g, '/');
    onChangeValues(mergeArtists(values, normalized));
    onChangeDraft('');
    setOpen(false);
    setActiveIndex(-1);
  }

  const copyText = joinArtists(mergeArtists(values, draft));

  async function copyAll() {
    if (disabled || !copyText) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      const active = document.activeElement;
      const area = document.createElement('textarea');
      area.value = copyText;
      area.readOnly = true;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
    }
    if (!ok) return;
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  function effectiveDest(state: Pick<PointerDrag, 'from' | 'over' | 'position'>): number {
    const raw = state.over + (state.position === 'after' ? 1 : 0);
    return raw > state.from ? raw - 1 : raw;
  }

  function locateTarget(clientX: number, clientY: number, from: number): { over: number; position: 'before' | 'after' } {
    const box = containerRef.current;
    if (!box) return { over: from, position: 'before' };
    const boxRect = box.getBoundingClientRect();
    if (clientY < boxRect.top - 60 || clientY > boxRect.bottom + 60 || clientX < boxRect.left - 80 || clientX > boxRect.right + 80) {
      return { over: from, position: 'before' };
    }
    const entries = [...box.querySelectorAll<HTMLElement>('.artist-chip')].map((el, index) => ({ index, rect: el.getBoundingClientRect() }));
    if (!entries.length) return { over: from, position: 'before' };

    let row = entries.filter(entry => clientY >= entry.rect.top - 6 && clientY <= entry.rect.bottom + 6);
    if (!row.length) {
      let best = entries[0];
      let bestDist = Math.abs(clientY - (best.rect.top + best.rect.bottom) / 2);
      for (const entry of entries.slice(1)) {
        const dist = Math.abs(clientY - (entry.rect.top + entry.rect.bottom) / 2);
        if (dist < bestDist) { best = entry; bestDist = dist; }
      }
      row = entries.filter(entry => Math.abs(entry.rect.top - best.rect.top) <= 8);
    }

    if (clientX <= row[0].rect.left) return { over: row[0].index, position: 'before' };
    if (clientX >= row[row.length - 1].rect.right) return { over: row[row.length - 1].index, position: 'after' };

    for (let i = 0; i < row.length; i++) {
      const nextMid = i + 1 < row.length ? (row[i].rect.right + row[i + 1].rect.left) / 2 : Infinity;
      if (clientX <= nextMid) {
        const ratio = row[i].index > from ? 0.35 : row[i].index < from ? 0.65 : 0.5;
        return { over: row[i].index, position: clientX < row[i].rect.left + row[i].rect.width * ratio ? 'before' : 'after' };
      }
    }
    return { over: row[row.length - 1].index, position: 'after' };
  }

  function startPointerDrag(event: ReactPointerEvent<HTMLSpanElement>, index: number) {
    if (disabled || values.length <= 1 || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (event.target instanceof HTMLElement && event.target.closest('.artist-chip-remove')) return;
    dragCleanupRef.current?.();
    const initial: PointerDrag = {
      from: index,
      name: values[index],
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      over: index,
      position: 'before',
    };
    dragRef.current = initial;

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('keydown', onKey, true);
      dragCleanupRef.current = null;
      dragRef.current = null;
      setDrag(null);
    };

    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || ev.pointerId !== cur.pointerId) return;
      const dx = ev.clientX - cur.startX;
      const dy = ev.clientY - cur.startY;
      if (!cur.active) {
        if (cur.pointerType === 'touch') {
          if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { cleanup(); return; }
          if (Math.abs(dx) < 6) return;
        } else if (Math.hypot(dx, dy) < 5) {
          return;
        }
        cur.active = true;
        setOpen(false);
        setActiveIndex(-1);
      }
      ev.preventDefault();
      const target = locateTarget(ev.clientX, ev.clientY, cur.from);
      const next: PointerDrag = { ...cur, x: ev.clientX, y: ev.clientY, ...target };
      dragRef.current = next;
      setDrag(next);
    };

    const onEnd = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || ev.pointerId !== cur.pointerId) return;
      cleanup();
      if (ev.type === 'pointerup' && cur.active) {
        const dest = effectiveDest(cur);
        const currentValues = valuesRef.current;
        if (dest !== cur.from && cur.from >= 0 && cur.from < currentValues.length && dest >= 0 && dest < currentValues.length) {
          const next = [...currentValues];
          const [moved] = next.splice(cur.from, 1);
          next.splice(dest, 0, moved);
          onChangeValuesRef.current(next);
        }
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && dragRef.current?.active) {
        ev.preventDefault();
        ev.stopPropagation();
        cleanup();
      }
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('keydown', onKey, true);
  }

  const activeDrag = drag?.active ? drag : null;
  const dropIndicator = activeDrag && effectiveDest(activeDrag) !== activeDrag.from ? activeDrag : null;

  return <>
    <div
      ref={containerRef}
      className={`artist-input-box${disabled ? ' disabled' : ''}${activeDrag ? ' is-dragging' : ''}`}
      onMouseDown={event => {
        if (disabled) return;
        if (event.target instanceof HTMLElement && event.target.closest('.artist-chip, .artist-copy-btn')) return;
        if (event.target !== inputRef.current) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <div className="artist-input-content">
        {values.map((name, index) => {
          const isDragging = activeDrag?.from === index;
          const isBefore = dropIndicator?.over === index && dropIndicator.position === 'before';
          const isAfter = dropIndicator?.over === index && dropIndicator.position === 'after';
          return <span
            key={`${name}-${index}`}
            className={`artist-chip${!disabled && values.length > 1 ? ' draggable' : ''}${isDragging ? ' dragging' : ''}${isBefore ? ' drop-before' : ''}${isAfter ? ' drop-after' : ''}`}
            onPointerDown={event => startPointerDrag(event, index)}
          >
            <span className="artist-chip-label" title={name}>{name}</span>
            <button
              type="button"
              className="artist-chip-remove"
              aria-label={`移除 ${name}`}
              title="移除"
              disabled={disabled}
              onMouseDown={event => event.stopPropagation()}
              onClick={() => removeAt(index)}
            ><X size={12} /></button>
          </span>;
        })}
        <input
          ref={inputRef}
          id={id}
          type="text"
          className="artist-input-field"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={showDropdown}
          aria-controls={showDropdown ? listboxId : undefined}
          aria-activedescendant={showDropdown && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          value={draft}
          disabled={disabled}
          maxLength={4096}
          placeholder={placeholder}
          onFocus={() => { if (trimmed) { setOpen(true); setActiveIndex(-1); } }}
          onBlur={() => { setOpen(false); setActiveIndex(-1); }}
          onChange={event => {
            const next = event.target.value;
            onChangeDraft(next);
            setOpen(next.trim().length > 0);
            setActiveIndex(-1);
          }}
          onKeyDown={onInputKeyDown}
          onPaste={onInputPaste}
        />
      </div>
      <button
        type="button"
        className={`artist-copy-btn${copied ? ' copied' : ''}`}
        aria-label={copied ? `已复制${ariaLabel}` : `复制全部${ariaLabel}`}
        title={copied ? '已复制' : '复制全部'}
        disabled={disabled || !copyText}
        onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
        onClick={() => { void copyAll(); }}
      >{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
    {activeDrag && createPortal(
      <span className="artist-chip artist-chip-ghost" aria-hidden="true" style={{ left: activeDrag.x, top: activeDrag.y }}>{activeDrag.name}</span>,
      document.body,
    )}
    {showDropdown && position && createPortal(
      <div
        ref={dropdownRef}
        id={listboxId}
        role="listbox"
        aria-label={`${ariaLabel}候选`}
        className="artist-dropdown"
        style={{
          left: position.left,
          width: position.width,
          maxHeight: position.maxHeight,
          ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
        } as CSSProperties}
      >
        {matches.map((artist, index) => <button
          key={artist.id}
          id={`${listboxId}-${index}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`artist-dropdown-option${index === activeIndex ? ' active' : ''}`}
          onMouseDown={event => event.preventDefault()}
          onClick={() => selectArtist(artist.name)}
        >
          <span className="artist-dropdown-name" title={artist.name}>{artist.name}</span>
          <small>{artist.trackCount} 首</small>
        </button>)}
      </div>,
      document.body,
    )}
  </>;
}
