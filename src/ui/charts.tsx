// Minimal SVG charts following the dataviz rules: one axis, recessive grid, 2px lines,
// >=8px markers, crosshair + tooltip on hover, legend for >= 2 series.
// Charts measure their real width (no viewBox stretching, so text never distorts).
import { useEffect, useRef, useState } from "preact/hooks";

export interface Point {
  x: number;
  y: number;
  label?: string;
}

export interface Series {
  name: string;
  color: string;
  points: Point[];
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(max / count)));
  const err = (count * step) / max;
  const mult = err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1;
  const s = step * mult;
  const ticks = [];
  for (let v = 0; v <= max + s * 0.001; v += s) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function useWidth<T extends HTMLElement>(): [preact.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Line chart over a categorical x (runs, evenly spaced, in order). `xLabel(i)` names run i.
 * Every series has a value per run index, or null where that series has no run.
 */
export function LineChart(props: {
  series: { name: string; color: string; values: (number | null)[] }[];
  xLabels: string[];
  height?: number;
  yMax?: number;
  yFormat: (v: number) => string;
  ariaLabel: string;
}) {
  const { series, xLabels, height = 240, yFormat } = props;
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = xLabels.length;
  const pad = { l: 48, r: 20, t: 14, b: 28 };
  const yMax =
    props.yMax ?? Math.max(1e-9, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const ticks = niceTicks(yMax);
  const top = Math.max(yMax, ticks[ticks.length - 1] ?? yMax);
  const innerW = Math.max(10, W - pad.l - pad.r);
  const sx = (i: number) => (n <= 1 ? pad.l + innerW / 2 : pad.l + (i / (n - 1)) * innerW);
  const sy = (y: number) => pad.t + (1 - y / top) * (height - pad.t - pad.b);

  const onMove = (ev: MouseEvent) => {
    const el = ref.current;
    if (!el || n === 0) return;
    const x = ev.clientX - el.getBoundingClientRect().left;
    let best = 0;
    for (let i = 0; i < n; i++) if (Math.abs(sx(i) - x) < Math.abs(sx(best) - x)) best = i;
    setHover(best);
  };

  if (n === 0) return <div class="empty">No data yet.</div>;
  // Label at most ~6 x positions so labels never collide.
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 110))));
  return (
    <div class="chart" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {W > 0 && (
        <svg width={W} height={height} role="img" aria-label={props.ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line
                class={t === 0 ? "baseline" : "gridline"}
                x1={pad.l}
                x2={W - pad.r}
                y1={sy(t)}
                y2={sy(t)}
              />
              <text class="axis-label" x={pad.l - 8} y={sy(t) + 4} text-anchor="end">
                {yFormat(t)}
              </text>
            </g>
          ))}
          {xLabels.map((l, i) =>
            i % every === 0 || i === n - 1 ? (
              <text
                class="axis-label"
                x={sx(i)}
                y={height - 8}
                text-anchor={n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              >
                {l}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <line class="crosshair" x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={height - pad.b} />
          )}
          {series.map((s) => {
            const pts = s.values
              .map((v, i) => (v === null ? null : ([sx(i), sy(v)] as const)))
              .filter(Boolean) as (readonly [number, number])[];
            return (
              <g key={s.name}>
                {pts.length > 1 && (
                  <polyline
                    class="series"
                    style={{ stroke: s.color }}
                    points={pts.map((p) => p.join(",")).join(" ")}
                  />
                )}
                {s.values.map((v, i) =>
                  v === null ? null : (
                    <circle
                      class="dot"
                      cx={sx(i)}
                      cy={sy(v)}
                      r={hover === i ? 6 : 4.5}
                      style={{ fill: s.color }}
                    />
                  ),
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && (
        <div class="tooltip" style={{ left: sx(hover), top: 6 }}>
          <div class="tooltip-title">{xLabels[hover]}</div>
          {series.map((s) =>
            s.values[hover] === null || s.values[hover] === undefined ? null : (
              <div class="tooltip-row" key={s.name}>
                <span class="stage-dot" style={{ background: s.color }} />
                {s.name}
                <span class="v">{yFormat(s.values[hover]!)}</span>
              </div>
            ),
          )}
        </div>
      )}
      {series.length > 1 && (
        <div class="legend" style={{ marginTop: 8 }}>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tiny cumulative line for a stat tile. */
export function Sparkline(props: { points: { x: number; y: number }[]; color: string; label: string }) {
  const { points } = props;
  if (points.length < 2)
    return <svg viewBox="0 0 100 24" style={{ height: 24, width: "100%" }} aria-hidden="true" />;
  const minX = points[0]!.x;
  const maxX = points[points.length - 1]!.x || minX + 1;
  const maxY = Math.max(...points.map((p) => p.y)) || 1;
  const sx = (x: number) => ((x - minX) / Math.max(1, maxX - minX)) * 100;
  const sy = (y: number) => 22 - (y / maxY) * 20;
  const line = points.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ");
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      style={{ height: 24, width: "100%" }}
      role="img"
      aria-label={props.label}
    >
      <title>{props.label}</title>
      <polygon points={`0,24 ${line} 100,24`} style={{ fill: props.color, opacity: 0.12 }} />
      <polyline
        points={line}
        style={{ fill: "none", stroke: props.color, strokeWidth: 2 }}
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}
