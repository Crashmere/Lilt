import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { timeLabel, type EditLine } from './lyric-document';

export type WaveView = { zoom: number; follow: boolean; start: number };

type DragState =
  | { kind: 'marker'; id: string; time: number; origin: number; x: number; moved: boolean; locked: boolean }
  | { kind: 'A' | 'B'; time: number; origin: number; x: number; moved: boolean };

const RULER_HEIGHT = 18;
const ZOOM_LEVELS = [1, 2, 4, 8, 16] as const;

function rulerLabel(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

export const LyricWaveform = memo(function LyricWaveform({
  peaks, duration, lines, offset, selected, editId, stampId, range, view, onView,
  position, getPosition, playing, onSelect, onMove, onSeek, onRange,
}: {
  peaks: number[]; duration: number; lines: EditLine[]; offset: number; selected: Set<string>;
  editId: string; stampId: string; range: [number, number]; view: WaveView; onView: (view: WaveView) => void;
  position: number; getPosition: () => number; playing: boolean;
  onSelect: (id: string) => void; onMove: (id: string, time: number) => void;
  onSeek: (time: number) => void; onRange?: (range: [number, number]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const markers = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const markerFrame = useRef(0);
  const layers = useRef<HTMLDivElement>(null);
  const [localView, setLocalView] = useState(view);
  const [cursor, setCursor] = useState<'crosshair' | 'ew-resize' | 'pointer'>('crosshair');
  const { zoom, follow, start } = localView;
  const viewRef = useRef(localView); viewRef.current = localView;
  function changeView(next: Partial<WaveView>, persist = true) {
    const value = { ...viewRef.current, ...next };
    viewRef.current = value;
    setLocalView(value);
    if (persist) onView(value);
  }
  useEffect(() => { viewRef.current = view; setLocalView(view); }, [view]);
  const drag = useRef<DragState | undefined>(undefined);
  const [size, setSize] = useState(0);
  const safeDuration = Math.max(1, duration);
  const span = safeDuration / zoom;
  const from = Math.min(start, Math.max(0, safeDuration - span));

  // Keep imperative refs updated on every render (avoids React 19.2 SimpleMemoComponent + useEffectEvent bug).
  const drawPeaksRef = useRef<() => void>(() => undefined);
  drawPeaksRef.current = () => {
    const element = canvas.current;
    if (!element) return;
    const width = element.clientWidth, height = element.clientHeight, ratio = window.devicePixelRatio || 1;
    if (width <= 0 || height <= 0) return;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const ctx = element.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Top timecode ruler
    ctx.fillStyle = '#1b1f1a';
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.fillStyle = '#2a2f28';
    ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);

    const tickStep = span <= 12000 ? 1000 : span <= 30000 ? 2000 : span <= 75000 ? 5000 : span <= 180000 ? 15000 : 30000;
    const firstTick = Math.ceil(from / tickStep) * tickStep;
    ctx.font = '10px ui-monospace, "DM Sans", monospace';
    for (let t = firstTick; t <= from + span; t += tickStep) {
      const x = Math.round((t - from) / span * width);
      if (x < 0 || x > width) continue;
      ctx.fillStyle = '#363c34';
      ctx.fillRect(x, RULER_HEIGHT - 6, 1, 6);
      if (x < width - 32) {
        ctx.fillStyle = '#848a7e';
        ctx.fillText(rulerLabel(t), x + 4, 12);
      }
    }

    // Center zero-axis subtle guide
    const waveTop = RULER_HEIGHT + 6;
    const waveH = Math.max(20, height - waveTop - 6);
    const midY = waveTop + waveH / 2;
    ctx.fillStyle = '#222620';
    ctx.fillRect(0, Math.round(midY), width, 1);

    // Amplitude peaks
    ctx.fillStyle = '#5d6757';
    for (let x = 0; x < width; x += 2) {
      const first = Math.floor((from + x / width * span) / safeDuration * peaks.length);
      const last = Math.ceil((from + (x + 2) / width * span) / safeDuration * peaks.length);
      let peak = 0;
      for (let i = Math.max(0, first); i <= Math.min(last, peaks.length - 1); i++) peak = Math.max(peak, peaks[i] || 0);
      const bar = Math.max(2, peak * (waveH - 6));
      ctx.fillRect(x, midY - bar / 2, 1.25, bar);
    }
  };

  const drawMarkersRef = useRef<() => void>(() => undefined);
  drawMarkersRef.current = () => {
    markerFrame.current = 0;
    const element = markers.current;
    if (!element) return;
    const width = element.clientWidth, height = element.clientHeight, ratio = window.devicePixelRatio || 1;
    if (width <= 0 || height <= 0) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const pw = Math.round(width * ratio), ph = Math.round(height * ratio);
    if (element.width !== pw || element.height !== ph) { element.width = pw; element.height = ph; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const activeA = drag.current?.kind === 'A' ? drag.current.time : range[0];
    const activeB = drag.current?.kind === 'B' ? drag.current.time : range[1];
    const ax = (activeA - from) / span * width;
    const bx = (activeB - from) / span * width;

    if (activeB > activeA) {
      const left = Math.max(0, ax), right = Math.min(width, bx);
      if (right > left) {
        ctx.fillStyle = 'rgba(224, 122, 79, 0.12)';
        ctx.fillRect(left, RULER_HEIGHT, right - left, height - RULER_HEIGHT);
      }
    }

    type MarkerItem = { line: EditLine; index: number; x: number; priority: number };
    const visible: MarkerItem[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.time === null || line.translation) continue;
      const time = drag.current?.kind === 'marker' && drag.current.id === line.id ? drag.current.time : line.time + offset;
      const x = (time - from) / span * width;
      if (x < -12 || x > width + 12) continue;
      const priority = line.id === stampId ? 3 : line.id === editId ? 2 : selected.has(line.id) ? 1 : 0;
      visible.push({ line, index, x, priority });
    }

    const byX = [...visible].sort((a, b) => a.x - b.x);
    const lanes = new Map<string, number>();
    const laneEnd = [-Infinity, -Infinity];
    for (const item of byX) {
      const lane = item.x >= laneEnd[0] ? 0 : item.x >= laneEnd[1] ? 1 : 0;
      lanes.set(item.line.id, lane);
      laneEnd[lane] = item.x + 30;
    }

    visible.sort((a, b) => a.priority - b.priority);
    ctx.font = '600 9.5px ui-monospace, "DM Sans", monospace';
    for (const { line, index, x } of visible) {
      const isTarget = line.id === stampId;
      const isEdit = line.id === editId;
      const isSel = selected.has(line.id);
      const color = line.locked ? '#9aa095' : isTarget ? '#e07a4f' : isEdit ? '#efece4' : isSel ? '#8ab4e6' : '#7ec26f';
      const lineWidth = isTarget || isEdit ? 2 : 1;

      ctx.fillStyle = color;
      ctx.fillRect(x, RULER_HEIGHT, lineWidth, height - RULER_HEIGHT);

      const label = `${String(index + 1).padStart(2, '0')}${isTarget ? ' K' : line.locked ? ' •' : ''}`;
      const flagW = Math.ceil(ctx.measureText(label).width) + 8;
      const lane = lanes.get(line.id) || 0;
      const flagY = RULER_HEIGHT + 3 + lane * 16;
      const flagX = x + flagW + 2 > width ? Math.max(2, x - flagW - 1) : x + 1;

      ctx.fillStyle = isTarget ? '#e07a4f' : isEdit ? '#2e332c' : 'rgba(22, 25, 21, 0.9)';
      ctx.fillRect(flagX, flagY, flagW, 14);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(flagX + 0.5, flagY + 0.5, flagW - 1, 13);
      ctx.fillStyle = isTarget ? '#141513' : color;
      ctx.fillText(label, flagX + 4, flagY + 10.5);
    }

    ctx.font = '700 9.5px "DM Sans", sans-serif';
    ([[ax, 'A'], [bx, 'B']] as const).forEach(([x, label]) => {
      if (x < -8 || x > width + 8) return;
      ctx.fillStyle = '#e07a4f';
      ctx.fillRect(x, RULER_HEIGHT, 1.5, height - RULER_HEIGHT);
      const tabX = Math.max(0, Math.min(width - 14, x - 7));
      ctx.fillRect(tabX, height - 15, 14, 15);
      ctx.fillStyle = '#141513';
      ctx.fillText(label, tabX + 3.5, height - 4);
    });
  };

  function scheduleMarkers() { if (!markerFrame.current) markerFrame.current = requestAnimationFrame(() => drawMarkersRef.current()); }

  const drawHeadRef = useRef<() => void>(() => undefined);
  drawHeadRef.current = () => {
    if (!head.current || !canvas.current) return;
    const width = canvas.current.clientWidth, x = (getPosition() - from) / span * width;
    head.current.style.visibility = x < 0 || x > width ? 'hidden' : 'visible';
    head.current.style.transform = `translateX(${x}px)`;
  };

  const followRef = useRef<() => void>(() => undefined);
  followRef.current = () => {
    if (!follow || zoom === 1 || !canvas.current) return;
    const target = Math.max(0, Math.min(safeDuration - span, getPosition() - span * 0.35));
    if (Math.abs(target - viewRef.current.start) * canvas.current.clientWidth / span >= 0.5) changeView({ start: target }, false);
  };

  const panRef = useRef<(event: WheelEvent) => void>(() => undefined);
  panRef.current = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || zoom === 1) return;
    const horizontal = event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!horizontal || !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
    event.preventDefault();
    const width = layers.current?.clientWidth || 1;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
    changeView({ follow: false, start: Math.max(0, Math.min(safeDuration - span, viewRef.current.start + horizontal * scale / width * span)) });
  };

  useLayoutEffect(() => { drawPeaksRef.current(); scheduleMarkers(); }, [peaks, from, span, safeDuration, zoom, size]);
  useEffect(() => { scheduleMarkers(); }, [lines, offset, selected, editId, stampId, range]);
  useLayoutEffect(() => { drawHeadRef.current(); }, [position, from, span, size]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { followRef.current(); drawHeadRef.current(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => { if (follow) followRef.current(); }, [position, follow, zoom]);
  useEffect(() => {
    const element = layers.current;
    const listener = (event: WheelEvent) => panRef.current(event);
    element?.addEventListener('wheel', listener, { passive: false });
    return () => element?.removeEventListener('wheel', listener);
  }, []);
  useEffect(() => () => cancelAnimationFrame(markerFrame.current), []);
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(() => setSize(n => n + 1));
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  function at(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(safeDuration, from + (event.clientX - bounds.left) / Math.max(1, bounds.width) * span)));
  }

  function hitTest(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const time = at(event);
    const threshold = span / Math.max(1, bounds.width) * 8;
    const nearBottom = event.clientY - bounds.top >= bounds.height - 22;
    if (onRange && (nearBottom || Math.abs(range[0] - time) <= threshold * 0.85)) {
      if (Math.abs(range[0] - time) <= threshold && Math.abs(range[0] - time) <= Math.abs(range[1] - time)) return { kind: 'A' as const, time };
      if (Math.abs(range[1] - time) <= threshold) return { kind: 'B' as const, time };
    }
    const candidates = lines
      .filter(line => line.time !== null && !line.translation && Math.abs(line.time + offset - time) <= threshold)
      .sort((a, b) => Math.abs(a.time! + offset - time) - Math.abs(b.time! + offset - time));
    if (candidates[0]) return { kind: 'marker' as const, line: candidates[0], time };
    if (onRange && Math.abs(range[0] - time) <= threshold) return { kind: 'A' as const, time };
    if (onRange && Math.abs(range[1] - time) <= threshold) return { kind: 'B' as const, time };
    return { kind: 'none' as const, time };
  }

  function setZoomCentered(nextZoom: number) {
    const nextSpan = safeDuration / nextZoom;
    const center = follow ? getPosition() : from + span / 2;
    const nextStart = nextZoom === 1 ? 0 : Math.max(0, Math.min(safeDuration - nextSpan, center - nextSpan * (follow ? 0.35 : 0.5)));
    changeView({ zoom: nextZoom, start: nextStart });
  }

  return <div className="lyric-waveform">
    <div className="lyric-wave-toolbar">
      <span className="lyric-wave-span">{timeLabel(from)} · {timeLabel(from + span)}</span>
      <div className="lyric-wave-actions">
        <button type="button" className={`wave-chip ${follow ? 'active' : ''}`} aria-pressed={follow} onClick={() => changeView({ follow: !follow })}>波形跟随</button>
        <div className="wave-zoom-group" role="group" aria-label="波形缩放">
          {ZOOM_LEVELS.map(n => <button key={n} type="button" className={zoom === n ? 'active' : ''} aria-pressed={zoom === n} onClick={() => setZoomCentered(n)}>{n}×</button>)}
        </div>
        <button type="button" className="wave-chip" onClick={() => {
          const line = lines.find(item => item.id === editId);
          if (line?.time != null) changeView({ start: Math.max(0, Math.min(safeDuration - span, line.time + offset - span / 2)), follow: false });
        }}>定位编辑行</button>
        <button type="button" className="wave-chip" onClick={() => changeView({ start: Math.max(0, Math.min(safeDuration - span, getPosition() - span / 2)), follow: true })}>定位播放位置</button>
      </div>
    </div>
    <div className="lyric-wave-layers" ref={layers}>
      <canvas ref={canvas} aria-hidden="true" />
      <canvas
        ref={markers}
        className="lyric-wave-markers"
        style={{ cursor }}
        aria-label="歌词波形时间轴，点击试听，拖动标记或 A/B 边界调整时间"
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary) return;
          const hit = hitTest(event);
          if (hit.kind === 'marker') {
            onSelect(hit.line.id);
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { kind: 'marker', id: hit.line.id, time: hit.line.time! + offset, origin: hit.line.time! + offset, x: event.clientX, moved: false, locked: !!hit.line.locked };
            scheduleMarkers();
          } else if (hit.kind === 'A' || hit.kind === 'B') {
            event.currentTarget.setPointerCapture(event.pointerId);
            const origin = hit.kind === 'A' ? range[0] : range[1];
            drag.current = { kind: hit.kind, time: origin, origin, x: event.clientX, moved: false };
            scheduleMarkers();
          } else {
            onSeek(hit.time);
          }
        }}
        onPointerMove={event => {
          const active = drag.current;
          if (!active) {
            const hit = hitTest(event);
            const nextCursor = hit.kind === 'A' || hit.kind === 'B' || hit.kind === 'marker' && !hit.line.locked ? 'ew-resize' : hit.kind === 'marker' ? 'pointer' : 'crosshair';
            if (nextCursor !== cursor) setCursor(nextCursor);
            return;
          }
          if (active.kind === 'marker') {
            if (!active.locked && (active.moved || Math.abs(event.clientX - active.x) >= 4)) {
              if (!active.moved) changeView({ follow: false });
              active.moved = true;
              active.time = at(event);
              scheduleMarkers();
            }
          } else if (active.moved || Math.abs(event.clientX - active.x) >= 3) {
            if (!active.moved) changeView({ follow: false });
            active.moved = true;
            const raw = at(event);
            active.time = active.kind === 'A'
              ? Math.max(0, Math.min(range[1] - 50, raw))
              : Math.min(safeDuration, Math.max(range[0] + 50, raw));
            scheduleMarkers();
          }
        }}
        onPointerUp={event => {
          const active = drag.current;
          if (!active) return;
          if (active.kind === 'marker') {
            if (active.moved) onMove(active.id, Math.max(0, active.time - offset));
            else onSeek(Math.max(0, active.origin - 1500));
          } else if (active.moved && onRange) {
            onRange(active.kind === 'A' ? [active.time, range[1]] : [range[0], active.time]);
          }
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          scheduleMarkers();
        }}
        onPointerCancel={() => { drag.current = undefined; scheduleMarkers(); }}
      />
      <div ref={head} className="lyric-wave-head" aria-hidden="true" />
    </div>
    {zoom > 1 && <div className="lyric-wave-scrubber">
      <input type="range" aria-label="波形查看范围" min={0} max={Math.max(0, safeDuration - span)} step="1" value={from} style={{ '--progress': `${safeDuration > span ? from / (safeDuration - span) * 100 : 0}%` } as CSSProperties} onChange={event => changeView({ follow: false, start: Number(event.target.value) })} />
    </div>}
  </div>;
});
