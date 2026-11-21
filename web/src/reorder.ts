import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { flushSync } from 'react-dom';
import type { Track } from './types';
import { duration } from './utils';

export type Reorder = (from: number, to: number) => void | Promise<void>;

type Drag = { from: number; boundary: number | null; order: string };
type Landing = { order: string; tops: number[]; to: number; settled: boolean };

export function useReorder(tracks: Track[], onReorder?: Reorder) {
  const root = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement | null>(null);
  const active = useRef<Drag | null>(null);
  const landing = useRef<Landing | null>(null);
  const animations = useRef(new Set<Animation>());
  const busy = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const order = JSON.stringify(tracks.map(track => track.id));
  const rows = () => [...root.current?.querySelectorAll<HTMLElement>('[data-reorder-index]') || []];
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = (row: HTMLElement) => row.getBoundingClientRect().top - root.current!.getBoundingClientRect().top + root.current!.scrollTop;

  function cancelAnimations() {
    animations.current.forEach(animation => animation.cancel());
    animations.current.clear();
  }

  function end() {
    preview.current?.remove();
    preview.current = null;
    active.current = null;
    setDrag(null);
  }

  useEffect(() => () => {
    preview.current?.remove();
    cancelAnimations();
  }, []);

  // Position feedback follows the local move; pending save feedback remains separate.
  useLayoutEffect(() => {
    const pending = landing.current;
    if (!pending || !root.current) return;
    if (pending.order !== order) {
      if (pending.settled) landing.current = null;
      return;
    }
    landing.current = null;
    if (reduced()) return;
    rows().forEach((row, index) => {
      const dy = pending.tops[index] - top(row);
      const animation = index === pending.to
        ? row.animate([
          { transform: 'scale(1.015)', backgroundColor: '#e7ecdd', boxShadow: '0 5px 18px #52623d20' },
          { transform: 'none', backgroundColor: getComputedStyle(row).backgroundColor, boxShadow: 'none' },
        ], { duration: 240, easing: 'cubic-bezier(.22,.8,.25,1)' })
        : Math.abs(dy) > .5
          ? row.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.22,.8,.25,1)' })
          : null;
      if (!animation) return;
      animations.current.add(animation);
      const finished = () => { animations.current.delete(animation); };
      void animation.finished.then(finished, finished);
    });
  });

  function move(from: number, to: number) {
    if (!onReorder || busy.current || from === to || !tracks[from] || !tracks[to]) return;
    const ids = tracks.map(track => track.id);
    const tops = rows().map(top);
    const [id] = ids.splice(from, 1);
    const [oldTop] = tops.splice(from, 1);
    ids.splice(to, 0, id);
    tops.splice(to, 0, oldTop);
    cancelAnimations();
    const pending: Landing = { order: JSON.stringify(ids), tops, to, settled: false };
    landing.current = pending;
    const result = onReorder(from, to);
    if (result) {
      busy.current = true;
      setSaving(to);
      const finish = () => {
        pending.settled = true;
        busy.current = false;
        if (root.current) setSaving(null);
      };
      void result.then(finish, finish);
    } else pending.settled = true;
  }

  function start(event: DragEvent<HTMLElement>, from: number) {
    if (!onReorder || busy.current || event.target !== event.currentTarget) { event.preventDefault(); return; }
    end();
    cancelAnimations();
    const track = tracks[from];
    const image = document.createElement('div');
    image.className = 'reorder-drag-image';
    image.setAttribute('aria-hidden', 'true');
    image.inert = true;
    const card = document.createElement('div');
    card.className = 'reorder-drag-card';
    const cover = event.currentTarget.closest('[data-reorder-index]')?.querySelector('.artwork')?.cloneNode(true) as HTMLElement | undefined;
    if (cover) {
      cover.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      cover.querySelectorAll('img').forEach(element => { element.loading = 'eager'; element.draggable = false; });
      card.append(cover);
    }
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = track.title || track.originalName;
    const credits = document.createElement('span');
    credits.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    text.append(title, credits);
    const time = document.createElement('small');
    time.textContent = duration(track.duration);
    card.append(text, time);
    image.append(card);
    document.body.append(image);
    preview.current = image;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-lilt-reorder', String(from));
    event.dataTransfer.setDragImage(image, 48, 46);
    active.current = { from, boundary: null, order };
    setDrag(active.current);
  }

  function locate(event: DragEvent<HTMLElement>, index: number) {
    const current = active.current;
    if (!current || current.order !== order) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const row = event.currentTarget;
    const rect = row.getBoundingClientRect();
    const shift = reduced() ? 0 : row.classList.contains('reorder-before') ? 4 : row.classList.contains('reorder-after') ? -4 : 0;
    const boundary = index + (event.clientY < rect.top - shift + rect.height / 2 ? 0 : 1);
    if (current.boundary !== boundary) {
      active.current = { ...current, boundary };
      setDrag(active.current);
    }
  }

  function drop(event: DragEvent<HTMLElement>, index: number) {
    locate(event, index);
    const current = active.current;
    if (!current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    // Commit the destination before native dragging ends, without painting the old source.
    flushSync(() => {
      end();
      if (current.order === order && current.boundary !== null) move(current.from, current.boundary - (current.boundary > current.from ? 1 : 0));
    });
  }

  function rowProps(index: number) {
    const destination = drag?.boundary == null ? null : drag.boundary - (drag.boundary > drag.from ? 1 : 0);
    const boundary = drag && destination !== drag.from ? drag.boundary : null;
    return {
      'data-reorder-index': index,
      className: [drag?.from === index ? 'reorder-source' : '', boundary === index ? 'reorder-before' : '', boundary === tracks.length && index === tracks.length - 1 ? 'reorder-after' : '', saving === index ? 'reorder-saving' : ''].join(' '),
      draggable: false,
      onDragEnter: (event: DragEvent<HTMLElement>) => locate(event, index),
      onDragOver: (event: DragEvent<HTMLElement>) => locate(event, index),
      onDrop: (event: DragEvent<HTMLElement>) => drop(event, index),
    };
  }

  function handleProps(index: number) {
    return {
      draggable: !!onReorder && saving === null,
      title: '拖动调整顺序',
      'aria-label': `拖动调整 ${tracks[index].title || tracks[index].originalName} 的顺序`,
      onDragStart: (event: DragEvent<HTMLElement>) => start(event, index),
      onDragEnd: end,
    };
  }

  return { root, rowProps, handleProps, saving, listProps: {
    className: drag ? 'is-reordering' : '',
    'aria-busy': saving !== null,
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      if (active.current) { active.current = { ...active.current, boundary: null }; setDrag(active.current); }
    },
  } };
}
