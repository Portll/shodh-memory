import { useMemo } from "react";
import { PlotFrame, MARK } from "./Plot";
import type { DegreeChart } from "./measures";

/**
 * Connected to nothing, drawn against everything that is connected.
 *
 * WHY A DISTRIBUTION AND NOT A NODE-LINK GRAPH. "Isolation is graph structure"
 * is right, and the obvious drawing — every memory a node, every shared term an
 * edge — is the wrong one here. Seventy-one memories with a median of four
 * neighbours is a few hundred edges, which force-directed layout renders as a
 * hairball with six dots parked outside it. The hairball carries no information
 * a reader can extract: you cannot count a node's edges by looking, so you
 * cannot see that the mass sits at four and the findings sit at zero. It also
 * costs a simulation and a frame budget to say one thing.
 *
 * The one thing it says is a DEGREE distribution, so that is what is drawn.
 * Every judged memory is placed by how many distinct other memories it reaches
 * through a shared term. The connected mass becomes a shape with a mode you can
 * see, and the findings become a column at zero — the same fact the hairball
 * was going to communicate, at a glance rather than after squinting, and
 * legible on a corpus of seventy or seven thousand.
 *
 * THE GAP AT ZERO IS THE POINT. Zero is not "a bit less than one" on this
 * measure, it is a different kind of statement: a memory at one shares a term
 * with something and is reachable, a memory at zero is not reachable at all.
 * The column at zero is therefore drawn in the flagged tone and separated by a
 * real gap, so the categorical break in the data is a visible break on screen
 * rather than the leftmost bar of a continuum.
 *
 * Memories that yielded no terms are ABSENT, not drawn at zero. Nothing can be
 * said about what they connect to, and putting them in the zero column would
 * merge "shares nothing" with "we could not tell", which is the one confusion
 * the lens's caveat exists to prevent.
 */

const W = 480;
const TOP = 18;
const PLOT_H = 96;
const AXIS_H = 34;
const PLOT_L = 34;
const PLOT_R = 468;
/** The visible break between "reaches nothing" and "reaches something". */
const ZERO_GAP = 10;

export function DegreePlot({ chart }: { chart: DegreeChart }) {
  const bins = useMemo(() => {
    const counts = new Array<number>(chart.maxCount + 1).fill(0);
    for (const c of chart.counts) counts[c] += 1;
    return counts;
  }, [chart.counts, chart.maxCount]);

  const tallest = bins.reduce((a, b) => Math.max(a, b), 1);
  const slots = chart.maxCount + 1;
  const slotW = (PLOT_R - PLOT_L - ZERO_GAP) / slots;
  const barW = Math.max(3, slotW * 0.74);
  const height = TOP + PLOT_H + AXIS_H;
  const baseY = TOP + PLOT_H;

  const xFor = (degree: number) =>
    PLOT_L + (degree >= 1 ? ZERO_GAP : 0) + degree * slotW + (slotW - barW) / 2;

  /** Round y gridlines that do not invent precision: at most three, on a step
   *  that divides the tallest bar sensibly. */
  const gridStep = tallest <= 4 ? 1 : tallest <= 10 ? 5 : 10;

  const summary = useMemo(() => {
    const reachAtLeastOne = chart.judged - chart.isolatedCount;
    return `Every judged memory placed by how many other memories it shares an extracted term with. ${chart.isolatedCount} of ${chart.judged} reach none — the separated column at zero. The other ${reachAtLeastOne} reach between 1 and ${chart.maxCount}, with a median of ${chart.medianCount}.`;
  }, [chart]);

  return (
    <PlotFrame
      title="How many other memories each one connects to"
      summary={summary}
      viewBox={`0 0 ${W} ${height}`}
    >
      {Array.from({ length: Math.floor(tallest / gridStep) + 1 }, (_, i) => i * gridStep)
        .filter((v) => v > 0)
        .map((v) => {
          const y = baseY - (v / tallest) * PLOT_H;
          return (
            <g key={v}>
              <line
                x1={PLOT_L}
                y1={y}
                x2={PLOT_R}
                y2={y}
                stroke={MARK.rule}
                strokeWidth={1}
                opacity={0.6}
              />
              <text
                x={PLOT_L - 5}
                y={y + 3}
                textAnchor="end"
                className="mono"
                fontSize={8.5}
                fill={MARK.ink}
              >
                {v}
              </text>
            </g>
          );
        })}

      <line x1={PLOT_L} y1={baseY} x2={PLOT_R} y2={baseY} stroke={MARK.rule} strokeWidth={1} />

      {bins.map((n, degree) => {
        if (n === 0) return null;
        const h = (n / tallest) * PLOT_H;
        const isolated = degree === 0;
        return (
          <rect
            key={degree}
            x={xFor(degree)}
            y={baseY - h}
            width={barW}
            height={h}
            rx={1.5}
            fill={isolated ? MARK.flagged : MARK.baseline}
            opacity={isolated ? 0.95 : 0.42}
          />
        );
      })}

      {/* The finding, counted on the plot. The only bar that gets a number,
          because it is the only bar that is a claim. */}
      {bins[0] > 0 ? (
        <text
          x={xFor(0) + barW / 2}
          y={baseY - (bins[0] / tallest) * PLOT_H - 5}
          textAnchor="middle"
          className="mono"
          fontSize={10.5}
          fill={MARK.flagged}
        >
          {bins[0]}
        </text>
      ) : null}

      {/* Where the ordinary memory sits, so the zero column has something to be
          far from. */}
      <g>
        <line
          x1={xFor(chart.medianCount) + barW / 2}
          y1={TOP - 6}
          x2={xFor(chart.medianCount) + barW / 2}
          y2={baseY}
          stroke={MARK.ink}
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.75}
        />
        <text
          x={xFor(chart.medianCount) + barW / 2}
          y={TOP - 9}
          textAnchor="middle"
          fontSize={8.5}
          fill={MARK.ink}
        >
          median
        </text>
      </g>

      {/* Ticks every five, plus zero, which always gets one because it is the
          column the section is about. */}
      {Array.from({ length: slots }, (_, d) => d)
        .filter((d) => d === 0 || d % 5 === 0)
        .map((d) => (
          <text
            key={d}
            x={xFor(d) + barW / 2}
            y={baseY + 13}
            textAnchor="middle"
            className="mono"
            fontSize={9}
            fill={d === 0 ? MARK.flagged : MARK.ink}
          >
            {d}
          </text>
        ))}

      <text x={PLOT_L} y={baseY + 27} textAnchor="start" fontSize={9} fill={MARK.ink} opacity={0.8}>
        memories sharing a term
      </text>
    </PlotFrame>
  );
}
