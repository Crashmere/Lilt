import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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

type DragState = { from: number; over: number; position: 'before' | 'after' };
type DropdownPosition = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

export function ArtistInput({ id, ariaLabel, values, draft, artists, disabled = false, placeholder, onChangeValues, onChangeDraft }: ArtistInputProps) {
  const instanceId = useId();
  const listboxId = `${instanceId}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [position, setPosition] = useState<DropdownPosition | null>(null);

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
    if (event.key === 'Backspace' && draft === '' && values.length > 0 && !disabled) {
      event.preventDefault();
      onChangeValues(values.slice(0, -1));
    }
  }

  function clearDrag() {
    dragRef.current = null;
    setDrag(null);
  }

  function effectiveDest(state: DragState): number {
    const raw = state.over + (state.position === 'after' ? 1 : 0);
    return raw > state.from ? raw - 1 : raw;
  }

  function startDrag(event: DragEvent<HTMLElement>, index: number) {
    if (disabled || values.length <= 1 || (event.target instanceof HTMLElement && event.target.closest('.artist-chip-remove'))) {
      event.preventDefault();
      return;
    }
    setOpen(false);
    setActiveIndex(-1);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-lilt-artist-reorder', `${instanceId}:${index}`);
    const next: DragState = { from: index, over: index, position: 'before' };
    dragRef.current = next;
    setDrag(next);
  }

  function overChip(event: DragEvent<HTMLElement>, index: number) {
    const current = dragRef.current;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = index > current.from ? 0.3 : index < current.from ? 0.7 : 0.5;
    const pos: 'before' | 'after' = event.clientX < rect.left + rect.width * ratio ? 'before' : 'after';
    if (current.over !== index || current.position !== pos) {
      const next: DragState = { ...current, over: index, position: pos };
      dragRef.current = next;
      setDrag(next);
    }
  }

  function overContainer(event: DragEvent<HTMLDivElement>) {
    const current = dragRef.current;
    if (!current || !values.length) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const last = values.length - 1;
    if (current.over !== last || current.position !== 'after') {
      const next: DragState = { ...current, over: last, position: 'after' };
      dragRef.current = next;
      setDrag(next);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    const current = dragRef.current;
    if (!current) return;
    event.preventDefault();
    event.stopPropagation();
    const dest = effectiveDest(current);
    clearDrag();
    if (dest !== current.from && current.from >= 0 && current.from < values.length && dest >= 0 && dest < values.length) {
      const next = [...values];
      const [moved] = next.splice(current.from, 1);
      next.splice(dest, 0, moved);
      onChangeValues(next);
    }
  }

  const dropIndicator = drag && effectiveDest(drag) !== drag.from ? drag : null;

  return <>
    <div
      ref={containerRef}
      className={`artist-input-box${disabled ? ' disabled' : ''}`}
      onMouseDown={event => {
        if (disabled) return;
        if (event.target instanceof HTMLElement && event.target.closest('.artist-chip-remove')) return;
        if (event.target !== inputRef.current) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
      onDragOver={overContainer}
      onDrop={handleDrop}
      onDragLeave={event => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (dragRef.current) {
          const reset: DragState = { ...dragRef.current, over: dragRef.current.from, position: 'before' };
          dragRef.current = reset;
          setDrag(reset);
        }
      }}
    >
      {values.map((name, index) => {
        const isDragging = drag?.from === index;
        const isBefore = dropIndicator?.over === index && dropIndicator.position === 'before';
        const isAfter = dropIndicator?.over === index && dropIndicator.position === 'after';
        return <span
          key={`${name}-${index}`}
          className={`artist-chip${!disabled && values.length > 1 ? ' draggable' : ''}${isDragging ? ' dragging' : ''}${isBefore ? ' drop-before' : ''}${isAfter ? ' drop-after' : ''}`}
          draggable={!disabled && values.length > 1}
          onDragStart={event => startDrag(event, index)}
          onDragEnter={event => overChip(event, index)}
          onDragOver={event => overChip(event, index)}
          onDrop={handleDrop}
          onDragEnd={clearDrag}
        >
          <span className="artist-chip-label" title={name}>{name}</span>
          <button
            type="button"
            className="artist-chip-remove"
            draggable={false}
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
      />
    </div>
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
