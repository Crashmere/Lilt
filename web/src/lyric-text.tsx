import type { LyricLine } from './utils';

export function LyricText({ line, sungThrough = -Infinity }: { line: LyricLine; sungThrough?: number }) {
  return <>{line.words?.length ? line.words.map((word, index) => <span key={index} className={`lyric-word ${word.time <= sungThrough ? 'sung' : ''}`}>{word.text}</span>) : line.text || '♪'}{line.secondary?.map((text, index) => <span className="lyric-secondary" key={index}>{text}</span>)}</>;
}
