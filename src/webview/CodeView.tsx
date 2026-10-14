import { useState } from 'react';
import type { SourceRange } from '../model/types';
import type { CodeFile, CodeToken } from '../shared/protocol';

type Segment = { kind: 'lines' | 'fold'; from: number; to: number };

/**
 * A file with one block's lines highlighted and everything else folded into
 * bars such as "⋯ 8 lines folded · lines 5–12" that expand on click.
 */
export function CodeView({ code, range }: { code: CodeFile; range: SourceRange }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const total = code.lines.length;
  const start = Math.min(Math.max(range.startLine, 1), total);
  const end = Math.min(Math.max(range.endLine, start), total);

  const segments: Segment[] = [];
  const outside = (from: number, to: number) => {
    if (to < from) return;
    const folded = to - from + 1 > 2 && !expanded.has(from);
    segments.push({ kind: folded ? 'fold' : 'lines', from, to });
  };
  outside(1, start - 1);
  segments.push({ kind: 'lines', from: start, to: end });
  outside(end + 1, total);

  return (
    <div className="fp-code">
      {segments.map((seg) =>
        seg.kind === 'fold' ? (
          <button
            key={`f${seg.from}`}
            className="fp-fold"
            onClick={() => setExpanded(new Set([...expanded, seg.from]))}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ⋯ {seg.to - seg.from + 1} lines folded · lines {seg.from}–{seg.to}
          </button>
        ) : (
          range1(seg.from, seg.to).map((n) => (
            <div key={n} className={n >= start && n <= end ? 'fp-line is-block' : 'fp-line'}>
              <span className="fp-ln">{n}</span>
              <span className="fp-src">{code.lines[n - 1].map(renderToken)}</span>
            </div>
          ))
        ),
      )}
    </div>
  );
}

function renderToken(t: CodeToken, i: number) {
  const style = t.color || t.fontStyle
    ? {
        color: t.color,
        fontStyle: t.fontStyle && t.fontStyle & 1 ? 'italic' : undefined,
        fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined,
        textDecoration: t.fontStyle && t.fontStyle & 4 ? 'underline' : undefined,
      }
    : undefined;
  return <span key={i} style={style}>{t.text}</span>;
}

function range1(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}
