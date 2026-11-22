import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { timeLabel, type EditLine } from './lyric-document';

export function LyricWaveform({ peaks, duration, lines, offset, selected, position, getPosition, playing, onMove, onSeek }: {
  peaks: number[]; duration: number; lines: EditLine[]; offset: number; selected: Set<string>; position: number; getPosition: () => number; playing: boolean;
  onMove: (id: string, time: number) => void; onSeek: (time: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const markers = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const markerFrame = useRef(0);
  const layers = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(4);
  const [follow, setFollow] = useState(true);
  const [start, setStart] = useState(0);
  const drag = useRef<{ id: string; time: number } | undefined>(undefined);
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
    lines.forEach(line => {
      if (line.time === null || line.translation) return;
      const time = drag.current?.id === line.id ? drag.current.time : line.time + offset;
      const x = (time - from) / span * width;
      if (x < 0 || x > width) return;
      ctx.fillStyle = selected.has(line.id) ? '#ae5937' : '#7b9060'; ctx.fillRect(x, 10, 1, height - 20);
      ctx.beginPath(); ctx.moveTo(x - 4, 7); ctx.lineTo(x + 4, 7); ctx.lineTo(x, 15); ctx.fill();
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
  useEffect(() => { scheduleMarkers(); }, [lines, offset, selected]);
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
    setStart(old => Math.abs(target - old) * canvas.current!.clientWidth / span >= 0.5 ? target : old);
  });
  useEffect(() => { if (follow) followPosition(); }, [position, follow, zoom]);
  const pan = useEffectEvent((event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || zoom === 1) return;
    const horizontal = event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!horizontal || !event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) return;
    event.preventDefault(); setFollow(false);
    const width = layers.current?.clientWidth || 1, scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
    setStart(old => Math.max(0, Math.min(duration - span, old + horizontal * scale / width * span)));
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
    <div className="lyric-wave-controls"><span>{timeLabel(from)} · {timeLabel(from + span)}</span><label className="lyric-follow"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />跟随播放</label><label>缩放<select aria-label="波形缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[1, 2, 4, 8, 16].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><button className="text-button" onClick={() => { setStart(Math.max(0, position - span / 2)); setFollow(true); }}>定位播放位置</button></div>
    <div className="lyric-wave-layers" ref={layers}><canvas ref={canvas} aria-hidden="true" /><canvas ref={markers} className="lyric-wave-markers" aria-label="歌词波形时间轴，点击试听，拖动标记调整时间" onPointerDown={event => {
      const time = at(event), threshold = span / event.currentTarget.clientWidth * 8;
      const candidates = lines.filter(line => line.time !== null && !line.translation && !line.locked && Math.abs(line.time + offset - time) <= threshold).sort((a, b) => Math.abs(a.time! + offset - time) - Math.abs(b.time! + offset - time));
      if (candidates[0]) { setFollow(false); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: candidates[0].id, time }; scheduleMarkers(); }
      else onSeek(time);
    }} onPointerMove={event => { if (drag.current) { drag.current.time = at(event); scheduleMarkers(); } }} onPointerUp={event => { if (drag.current) { onMove(drag.current.id, Math.max(0, at(event) - offset)); drag.current = undefined; scheduleMarkers(); } }} onPointerCancel={() => { drag.current = undefined; scheduleMarkers(); }} /><div ref={head} className="lyric-wave-head" aria-hidden="true" /></div>
    {zoom > 1 && <input type="range" aria-label="波形查看范围" min={0} max={Math.max(0, duration - span)} step="0.001" value={from} onChange={event => { setFollow(false); setStart(Number(event.target.value)); }} />}
  </div>;
}
