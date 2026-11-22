import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { timeLabel, type EditLine } from './lyric-document';

export function LyricWaveform({ peaks, duration, lines, offset, selected, position, onMove, onSeek }: {
  peaks: number[]; duration: number; lines: EditLine[]; offset: number; selected: Set<string>; position: number;
  onMove: (id: string, time: number) => void; onSeek: (time: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [start, setStart] = useState(0);
  const [drag, setDrag] = useState<{ id: string; time: number }>();
  const [size, setSize] = useState(0);
  const span = duration / zoom;
  const from = Math.min(start, Math.max(0, duration - span));
  const draw = useEffectEvent(() => {
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
    lines.forEach(line => {
      if (line.time === null || line.translation) return;
      const time = drag?.id === line.id ? drag.time : line.time + offset;
      const x = (time - from) / span * width;
      if (x < 0 || x > width) return;
      ctx.fillStyle = selected.has(line.id) ? '#ae5937' : '#7b9060'; ctx.fillRect(x, 10, 1, height - 20);
      ctx.beginPath(); ctx.moveTo(x - 4, 7); ctx.lineTo(x + 4, 7); ctx.lineTo(x, 15); ctx.fill();
    });
    const x = (position - from) / span * width;
    ctx.fillStyle = '#2a2d29'; ctx.fillRect(x, 0, 2, height);
  });
  useEffect(() => { draw(); }, [peaks, lines, offset, selected, position, from, span, drag, size]);
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
    <div className="lyric-wave-controls"><span>{timeLabel(from)} · {timeLabel(from + span)}</span><label>缩放<select aria-label="波形缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[1, 2, 4, 8, 16].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><button className="text-button" onClick={() => setStart(Math.max(0, position - span / 2))}>定位播放位置</button></div>
    <canvas ref={canvas} aria-label="歌词波形时间轴，点击试听，拖动标记调整时间" onPointerDown={event => {
      const time = at(event), threshold = span / event.currentTarget.clientWidth * 8;
      const candidates = lines.filter(line => line.time !== null && !line.translation && !line.locked && Math.abs(line.time + offset - time) <= threshold).sort((a, b) => Math.abs(a.time! + offset - time) - Math.abs(b.time! + offset - time));
      if (candidates[0]) { event.currentTarget.setPointerCapture(event.pointerId); setDrag({ id: candidates[0].id, time }); }
      else onSeek(time);
    }} onPointerMove={event => { if (drag) setDrag({ ...drag, time: at(event) }); }} onPointerUp={event => { if (drag) { onMove(drag.id, Math.max(0, at(event) - offset)); setDrag(undefined); } }} onPointerCancel={() => setDrag(undefined)} />
    {zoom > 1 && <input type="range" aria-label="波形查看范围" min={0} max={Math.max(0, duration - span)} value={from} onChange={event => setStart(Number(event.target.value))} />}
  </div>;
}
