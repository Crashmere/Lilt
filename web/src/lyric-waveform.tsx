import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { timeLabel, type EditLine } from './lyric-document';

export type WaveView = { zoom: number; follow: boolean; start: number };

export function LyricWaveform({ peaks, duration, lines, offset, selected, editId, range, view, onView, position, getPosition, playing, onSelect, onMove, onSeek }: {
  peaks: number[]; duration: number; lines: EditLine[]; offset: number; selected: Set<string>; position: number; getPosition: () => number; playing: boolean;
  editId: string; range: [number, number]; view: WaveView; onView: (view: WaveView) => void;
  onSelect: (id: string) => void; onMove: (id: string, time: number) => void; onSeek: (time: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const markers = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const markerFrame = useRef(0);
  const layers = useRef<HTMLDivElement>(null);
  const [localView, setLocalView] = useState(view);
  const { zoom, follow, start } = localView;
  const viewRef = useRef(localView); viewRef.current = localView;
  function changeView(next: Partial<WaveView>, persist = true) { const value = { ...viewRef.current, ...next }; viewRef.current = value; setLocalView(value); if (persist) onView(value); }
  useEffect(() => { setLocalView(view); }, [view]);
  const drag = useRef<{ id: string; time: number; x: number; origin: number; moved: boolean; locked: boolean } | undefined>(undefined);
  const [size, setSize] = useState(0);
  const span = duration / zoom;
  const from = Math.min(start, Math.max(0, duration - span));
  const drawPeaks = useEffectEvent(() => {
    const element = canvas.current;
    if (!element) return;
    const width = element.clientWidth, height = element.clientHeight, ratio = window.devicePixelRatio || 1;
    element.width = width * ratio; element.height = height * ratio;
    const ctx = element.getContext('2d'); if (!ctx) return;
    ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#b8b6a6';
    for (let x = 0; x < width; x += 2) {
      const first = Math.floor((from + x / width * span) / duration * peaks.length);
      const last = Math.ceil((from + (x + 2) / width * span) / duration * peaks.length);
      let peak = 0; for (let i = first; i <= Math.min(last, peaks.length - 1); i++) peak = Math.max(peak, peaks[i] || 0);
      const bar = Math.max(2, peak * (height - 35)); ctx.fillRect(x, (height - bar) / 2, 1, bar);
    }
  });
  const drawMarkers = useEffectEvent(() => {
    markerFrame.current = 0;
    const element = markers.current;
    if (!element) return;
    const width = element.clientWidth, height = element.clientHeight, ratio = window.devicePixelRatio || 1;
    const ctx = element.getContext('2d'); if (!ctx) return;
    if (element.width !== width * ratio || element.height !== height * ratio) { element.width = width * ratio; element.height = height * ratio; }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const a = (range[0] - from) / span * width, b = (range[1] - from) / span * width;
    if (range[1] > range[0]) { ctx.fillStyle = '#ae593714'; ctx.fillRect(Math.max(0, a), 0, Math.max(0, Math.min(width, b) - Math.max(0, a)), height); }
    ctx.font = '10px sans-serif';
    [[a, 'A'], [b, 'B']].forEach(([x, label]) => { if (Number(x) < 0 || Number(x) > width) return; ctx.fillStyle = '#ae5937'; ctx.fillRect(Number(x), 0, 1, height); ctx.fillText(String(label), Math.max(2, Math.min(width - 12, Number(x) + 4)), height - 4); });
    lines.forEach(line => {
      if (line.time === null || line.translation) return;
      const time = drag.current?.id === line.id ? drag.current.time : line.time + offset;
      const x = (time - from) / span * width;
      if (x < 0 || x > width) return;
      ctx.fillStyle = line.locked ? '#777164' : selected.has(line.id) || editId === line.id ? '#ae5937' : '#7b9060'; ctx.fillRect(x, 10, line.id === editId ? 2 : 1, height - 20);
      ctx.beginPath(); ctx.moveTo(x - 4, 7); ctx.lineTo(x + 4, 7); ctx.lineTo(x, 15); ctx.fill();
      if (line.id === editId) ctx.fillText(String(lines.indexOf(line) + 1), Math.min(width - 14, x + 5), 24);
    });
  });
  function scheduleMarkers() { if (!markerFrame.current) markerFrame.current = requestAnimationFrame(drawMarkers); }
  const drawHead = useEffectEvent(() => {
    if (!head.current || !canvas.current) return;
    const width = canvas.current.clientWidth, x = (getPosition() - from) / span * width;
    head.current.style.visibility = x < 0 || x > width ? 'hidden' : 'visible';
    head.current.style.transform = `translateX(${x}px)`;
  });
  useEffect(() => { drawPeaks(); scheduleMarkers(); }, [peaks, from, span, size]);
  useEffect(() => { scheduleMarkers(); }, [lines, offset, selected, editId, range]);
  useEffect(() => { drawHead(); }, [position, from, span, size]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { followPosition(); drawHead(); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  const followPosition = useEffectEvent(() => {
    if (!follow || zoom === 1 || !canvas.current) return;
    const target = Math.max(0, Math.min(duration - span, getPosition() - span * 0.35));
    if (Math.abs(target - viewRef.current.start) * canvas.current.clientWidth / span >= 0.5) changeView({ start: target }, false);
  });
  useEffect(() => { if (follow) followPosition(); }, [position, follow, zoom]);
  const pan = useEffectEvent((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || zoom === 1) return;
    const horizontal = event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!horizontal || !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
    event.preventDefault();
    const width = layers.current?.clientWidth || 1, scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
    changeView({ follow: false, start: Math.max(0, Math.min(duration - span, viewRef.current.start + horizontal * scale / width * span)) });
  });
  useEffect(() => {
    const element = layers.current;
    element?.addEventListener('wheel', pan, { passive: false });
    return () => element?.removeEventListener('wheel', pan);
  }, []);
  useEffect(() => () => cancelAnimationFrame(markerFrame.current), []);
  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(() => setSize(n => n + 1)); observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  function at(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(duration, from + (event.clientX - bounds.left) / bounds.width * span)));
  }
  return <div className="lyric-waveform">
    <div className="lyric-wave-controls"><span>{timeLabel(from)} · {timeLabel(from + span)}</span><label className="lyric-follow"><input type="checkbox" checked={follow} onChange={event => changeView({ follow: event.target.checked })} />波形跟随</label><label>缩放<select aria-label="波形缩放" value={zoom} onChange={event => changeView({ zoom: Number(event.target.value) })}>{[1, 2, 4, 8, 16].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><button className="text-button" onClick={() => { const line = lines.find(item => item.id === editId); if (line?.time != null) changeView({ start: Math.max(0, line.time + offset - span / 2), follow: false }); }}>定位编辑行</button><button className="text-button" onClick={() => changeView({ start: Math.max(0, position - span / 2), follow: true })}>定位播放位置</button></div>
    <div className="lyric-wave-layers" ref={layers}><canvas ref={canvas} aria-hidden="true" /><canvas ref={markers} className="lyric-wave-markers" aria-label="歌词波形时间轴，点击试听，拖动标记调整时间" onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      const time = at(event), threshold = span / event.currentTarget.clientWidth * 8;
      const candidates = lines.filter(line => line.time !== null && !line.translation && Math.abs(line.time + offset - time) <= threshold).sort((a, b) => Math.abs(a.time! + offset - time) - Math.abs(b.time! + offset - time));
      if (candidates[0]) { const line = candidates[0]; onSelect(line.id); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: line.id, time: line.time! + offset, origin: line.time! + offset, x: event.clientX, moved: false, locked: !!line.locked }; scheduleMarkers(); }
      else onSeek(time);
    }} onPointerMove={event => { const marker = drag.current; if (marker && !marker.locked && (marker.moved || Math.abs(event.clientX - marker.x) >= 4)) { if (!marker.moved) changeView({ follow: false }); marker.moved = true; marker.time = at(event); scheduleMarkers(); } }} onPointerUp={event => { const marker = drag.current; if (marker) { if (marker.moved) onMove(marker.id, Math.max(0, marker.time - offset)); else onSeek(Math.max(0, marker.origin - 1500)); drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); scheduleMarkers(); } }} onPointerCancel={() => { drag.current = undefined; scheduleMarkers(); }} /><div ref={head} className="lyric-wave-head" aria-hidden="true" /></div>
    {zoom > 1 && <input type="range" aria-label="波形查看范围" min={0} max={Math.max(0, duration - span)} step="0.001" value={from} onChange={event => changeView({ follow: false, start: Number(event.target.value) })} />}
  </div>;
}
