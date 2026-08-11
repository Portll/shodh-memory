import { useMemo } from "react";
import { scaleLog } from "d3";
import { useSession } from "@/stores/session";
import { PlotFrame, MARK } from "./Plot";
import type { RatioChart } from "./measures";

/**
 * Numbers that do not fit, drawn as the gap between them.
 *
 * THE AXIS IS A RATIO, WHICH IS WHY THERE IS ONLY ONE OF THEM. This section
 * mixes units by construction — a kilogram disagreement and a millisecond
 * disagreement are both findings here — and the first instinct, an axis per
 * unit, is the dual-axis mistake wearing a different hat: two scales on one
 * picture, with the reader silently invited to compare lengths that are not
 * comparable. So the plotted quantity is `max / min`, which is DIMENSIONLESS.
 * "6.8× apart" and "3.7× apart" are the same kind of statement whether the
 * numbers were kilograms or milliseconds, and a bar twice as long really does
 * mean twice the disagreement. The absolute values stay on the row as text, in
 * their own units, where they belong.
 *
 * THE AXIS IS LOG, WHICH IS HOW IT SURVIVES ORDERS OF MAGNITUDE. A declared
 * weight against a weighbridge reading differs by 6.8×; a corpus outlier can
 * differ by 500×. On a linear ratio axis the first would be a stub beside the
 * second — the exact defect that got the earlier severity bar deleted. On a
 * log axis every doubling is the same distance, so a 6.8× row and a 3.7× row
 * are both legible on a plot that a 500× row would also fit.
 *
 * Every bar starts at 1×. That shared origin is what makes the lengths
 * comparable at a glance, and it is also the honest zero of this measure: 1×
 * is two numbers agreeing exactly.
 */

const W = 480;
const ROW_H = 44;
const TOP = 16;
const AXIS_H = 30;
/** Left of this is the low value's label; right of `PLOT_R` is the high
 *  value's. Both are reserved rather than measured, so a long number never
 *  reflows the axis and desynchronises one row from the next. */
const PLOT_L = 92;
const PLOT_R = 384;

function formatValue(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** 1, 2, 5 per decade — the standard log tick mantissas, which keep the labels
 *  readable without implying a precision the scale does not have. */
function logTicks(max: number): number[] {
  const ticks: number[] = [];
  for (let decade = 0; decade <= Math.ceil(Math.log10(max)); decade++) {
    for (const mantissa of [1, 2, 5]) {
      const value = mantissa * 10 ** decade;
      if (value <= max) ticks.push(value);
    }
  }
  return ticks;
}

export function RatioPlot({ chart }: { chart: RatioChart }) {
  const selectedId = useSession((s) => s.selectedMemoryId);
  const select = useSession((s) => s.select);

  const pairs = chart.pairs.filter((p) => Number.isFinite(p.factor));
  const height = TOP + pairs.length * ROW_H + AXIS_H;

  // Headroom so the longest bar does not terminate exactly on the frame edge,
  // where its end dot and its label would be clipped.
  const domainMax = Math.max(chart.maxFactor * 1.25, 2);
  const x = useMemo(
    () => scaleLog().domain([1, domainMax]).range([PLOT_L, PLOT_R]).clamp(true),
    [domainMax],
  );

  const summary = useMemo(() => {
    if (pairs.length === 0) return "No pair of same-unit figures disagrees.";
    const list = pairs
      .map(
        (p) =>
          `${formatValue(p.lowValue)} against ${formatValue(p.highValue)} ${p.unit}, ${p.factor.toFixed(1)} times apart`,
      )
      .join("; ");
    return `Each bar is the gap between two figures written in the same unit, on a shared log scale of how many times apart they are. ${list}.`;
  }, [pairs]);

  const ticks = logTicks(domainMax);

  return (
    <PlotFrame
      title="How far apart the disagreeing figures are"
      summary={summary}
      viewBox={`0 0 ${W} ${height}`}
    >
      {/* Gridlines first and faint: the axis is a reading aid, the bars are
          the data. */}
      {ticks.map((t) => (
        <line
          key={t}
          x1={x(t)}
          y1={TOP - 6}
          x2={x(t)}
          y2={TOP + pairs.length * ROW_H}
          stroke={MARK.rule}
          strokeWidth={1}
          opacity={t === 1 ? 1 : 0.55}
        />
      ))}

      {pairs.map((pair, i) => {
        const y = TOP + i * ROW_H + ROW_H / 2;
        const x2 = x(pair.factor);
        const isSelected = pair.memoryId === selectedId;
        const colour = isSelected ? MARK.selected : MARK.flagged;
        // For a corpus outlier the baseline end is the unit's median, and
        // saying so matters: without it the row reads as though the memory
        // stated both numbers, which is a different and stronger finding.
        const baselineEndIsTypical = pair.scope === "corpus";
        const flaggedAtLowEnd = pair.scope === "corpus" && pair.lowIsFlagged;

        return (
          <g
            key={`${pair.memoryId}-${pair.unit}-${pair.factor}`}
            onClick={() => select(pair.memoryId)}
            className="cursor-pointer"
          >
            <title>
              {`${formatValue(pair.lowValue)} against ${formatValue(pair.highValue)} ${pair.unit}, ${pair.factor.toFixed(1)} times apart`}
            </title>

            {/* The gap itself. Its LENGTH is the finding. */}
            <line
              x1={PLOT_L}
              y1={y}
              x2={x2}
              y2={y}
              stroke={colour}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.85}
            />

            {/* The two ends. The baseline end is hollow when it is a median
                rather than a figure the memory wrote — a filled dot means "the
                corpus states this number", and the distinction is free here. */}
            <circle
              cx={PLOT_L}
              cy={y}
              r={4}
              fill={baselineEndIsTypical && !flaggedAtLowEnd ? "var(--background)" : colour}
              stroke={colour}
              strokeWidth={1.6}
            />
            <circle
              cx={x2}
              cy={y}
              r={4}
              fill={baselineEndIsTypical && flaggedAtLowEnd ? "var(--background)" : colour}
              stroke={colour}
              strokeWidth={1.6}
            />

            {/* The factor, above the bar it measures — the one number a reader
                needs before any label. */}
            <text
              x={(PLOT_L + x2) / 2}
              y={y - 8}
              textAnchor="middle"
              className="mono"
              fontSize={11}
              fill={colour}
            >
              {`${pair.factor.toFixed(1)}×`}
            </text>

            <text
              x={PLOT_L - 8}
              y={y + 3.6}
              textAnchor="end"
              className="mono"
              fontSize={10.5}
              fill="var(--foreground)"
              opacity={0.85}
            >
              {formatValue(pair.lowValue)}
            </text>
            <text
              x={x2 + 8}
              y={y + 3.6}
              textAnchor="start"
              className="mono"
              fontSize={10.5}
              fill="var(--foreground)"
              opacity={0.85}
            >
              {`${formatValue(pair.highValue)} ${pair.unit}`}
            </text>

            {baselineEndIsTypical ? (
              <text
                x={flaggedAtLowEnd ? x2 : PLOT_L}
                y={y + 15}
                textAnchor="middle"
                fontSize={8.5}
                fill={MARK.ink}
              >
                typical
              </text>
            ) : null}
          </g>
        );
      })}

      {/* The axis, last and quiet. */}
      {ticks.map((t) => (
        <text
          key={t}
          x={x(t)}
          y={TOP + pairs.length * ROW_H + 14}
          textAnchor="middle"
          className="mono"
          fontSize={9}
          fill={MARK.ink}
        >
          {`${t}×`}
        </text>
      ))}
      <text
        x={PLOT_R + 8}
        y={TOP + pairs.length * ROW_H + 14}
        textAnchor="start"
        fontSize={9}
        fill={MARK.ink}
        opacity={0.8}
      >
        apart
      </text>
    </PlotFrame>
  );
}
