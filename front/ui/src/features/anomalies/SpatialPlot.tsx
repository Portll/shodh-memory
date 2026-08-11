import { useMemo } from "react";
import { scaleSymlog } from "d3";
import { useSession } from "@/stores/session";
import { PlotFrame, MARK } from "./Plot";
import type { Pattern, SpatialChart } from "./measures";

/**
 * Out of place, drawn in the corpus's own coordinates.
 *
 * WHY POLAR AND NOT A MAP. A map of this corpus is unreadable: 32 of the 36
 * placed memories sit inside one harbour and two sit 260 km away, so a
 * projection fitted to the extent draws the harbour as a single pixel, and one
 * fitted to the harbour pushes the findings off-canvas. Insets would fix the
 * geometry and destroy the comparison, which is the only thing this lens is
 * for. The measure does not compare places, it compares DISTANCE FROM THE
 * CORPUS'S OWN CENTRE against the spread of those distances — so the plot is
 * drawn in exactly those terms: radius is that distance, angle is the true
 * bearing, and the cutoff the measure computed is a ring you can see points
 * fall outside of.
 *
 * WHY THE RADIUS IS SYMMETRIC-LOG. This is the scaling problem the brief names
 * and the reason the previous severity bar was deleted. The distances here run
 * 1.02 km to 259.85 km — a factor of 255 — so a linear radius spends 96% of
 * itself on the four outliers and renders the 32-memory cluster as one blob
 * with no internal structure, which is precisely the "genuine finding drawn as
 * a stub" failure that got the bar removed. A plain log scale fixes the range
 * and introduces a worse bug: log(0) is negative infinity, and a memory sitting
 * exactly at the cluster centre is not a corner case but the ordinary result of
 * a corpus whose median coordinate IS one of its coordinates. `scaleSymlog` is
 * linear through a region set by `constant` and logarithmic beyond it, so zero
 * maps to zero honestly, no floor has to be invented, and the harbour keeps its
 * internal spread while 260 km still fits on the same radius.
 *
 * The constant is the corpus's own typical distance rather than d3's default of
 * 1. That makes the linear region mean something — "out to about as far as
 * these normally sit, distance reads directly; past that it compresses" —
 * instead of depending on whether the data happens to be denominated in
 * kilometres or metres.
 *
 * WHAT THE ANGLE IS FOR, AND THE CLAIM IT CORRECTS. Bearing is real measured
 * direction, and on this corpus it overturns the obvious reading of the two
 * furthest findings. They sit at 259.3 km and 259.9 km — all but identical —
 * and it is tempting to call them one diversion. They are at bearings of 175°
 * and 52°: one went south to Norfolk, the other north-east to New York. Same
 * cause, same distance, OPPOSITE directions. A distance-only plot would have
 * hidden that, and a plot that drew them as one arrow would have asserted
 * something false.
 */

/** Authored geometry. The frame scales this to the column's width, so these are
 *  proportions rather than pixels — see PlotFrame. */
const W = 480;
const H = 300;
const CX = 240;
const CY = 150;
/** Distance 0 does not collapse onto the centre mark: a memory AT the centre is
 *  a real result and needs somewhere to be drawn that is not the crosshair. */
const R0 = 16;
const R_MAX = 124;

/** Screen position of a polar coordinate. Bearing is clockwise from north and
 *  the screen's y axis points down, which is why cos carries y and sin carries
 *  x — the usual pairing, transposed once, here, and nowhere else. */
function place(radius: number, bearing: number): [number, number] {
  const t = (bearing * Math.PI) / 180;
  return [CX + radius * Math.sin(t), CY - radius * Math.cos(t)];
}

function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/**
 * Distances to mark along the radius, so the log scale is legible rather than
 * merely correct.
 *
 * A reader who has not been told the radius is logarithmic will read it as
 * linear and badly misjudge the cluster — which would be this plot lying by
 * omission. Three ticks on the west spoke fix that: once "1 km" and "100 km"
 * are visibly NOT twice as far apart as "1 km" and "2 km", the compression is
 * self-evident and needs no caption.
 *
 * Candidates are the standard 1/2/5-per-decade values, thinned to at most three
 * that are actually separated on screen — a ruler whose labels overlap teaches
 * nothing.
 */
function rulerTicks(maxKm: number, radius: (km: number) => number): number[] {
  const candidates: number[] = [];
  for (let decade = -3; decade <= 5; decade++) {
    for (const mantissa of [1, 2, 5]) {
      const value = mantissa * 10 ** decade;
      if (value > 0 && value < maxKm) candidates.push(value);
    }
  }
  if (candidates.length === 0) return [];
  const spread = radius(maxKm) - radius(candidates[0]);
  const minGap = Math.max(18, spread / 4);
  const chosen: number[] = [];
  for (const value of candidates) {
    if (chosen.length === 0 || radius(value) - radius(chosen[chosen.length - 1]) >= minGap) {
      chosen.push(value);
    }
  }
  return chosen.slice(-3);
}

export function SpatialPlot({
  chart,
  patterns,
}: {
  chart: SpatialChart;
  patterns: Pattern[];
}) {
  const selectedId = useSession((s) => s.selectedMemoryId);
  const select = useSession((s) => s.select);

  const radius = useMemo(() => {
    // The outer edge is the furthest memory, so the plot always uses its whole
    // radius; a fixed maximum would leave a corpus that spans 40 km drawn
    // inside a quarter of the circle for no reason.
    const scale = scaleSymlog()
      .domain([0, Math.max(chart.maxKm, chart.cutoffKm)])
      .range([R0, R_MAX])
      // A degenerate corpus where every memory shares one coordinate has a
      // typical distance of 0, which is not a legal symlog constant.
      .constant(Math.max(chart.typicalKm, 1e-6));
    return (km: number) => scale(km);
  }, [chart.maxKm, chart.cutoffKm, chart.typicalKm]);

  const flagged = chart.points.filter((p) => p.flagged).sort((a, b) => b.km - a.km);
  const baseline = chart.points.filter((p) => !p.flagged);
  /** The busiest stack INSIDE the line. Counting the flagged points into this
   *  would be arithmetic about a different set than the sentence is describing. */
  const busiest = baseline.reduce((a, p) => Math.max(a, p.memoryIds.length), 0);

  const summary = useMemo(() => {
    const inside = chart.placed - flagged.reduce((a, p) => a + p.memoryIds.length, 0);
    const list = flagged.map((p) => formatKm(p.km)).join(", ");
    // The position count has to be the count for the memories the clause is
    // about — the ones inside the line — not the plot's total. Saying "32 sit
    // within 9.5 km, sharing 16 distinct positions" folded the four outliers'
    // own positions into a sentence about the cluster, which is a small false
    // statement on a screen whose entire argument is that its arithmetic can be
    // checked.
    return `Distance from the cluster centre, on a log radius, against true bearing. ${inside} of ${chart.placed} placed memories sit within ${formatKm(chart.cutoffKm)} of the centre${
      busiest > 1
        ? `, across ${baseline.length} distinct positions — the busiest holding ${busiest}`
        : ""
    }. ${
      flagged.length === 0
        ? "None fall outside the flag line."
        : `${flagged.length} fall outside the flag line, at ${list}.`
    }`;
  }, [chart, flagged, baseline.length, busiest]);

  const rCut = radius(chart.cutoffKm);
  const rTyp = radius(chart.typicalKm);

  return (
    <PlotFrame title="Distance and direction from the cluster centre" summary={summary} viewBox={`0 0 ${W} ${H}`}>
      {/* Spokes at the cardinals. Faint, because they are a reading aid for
          angle and not a feature of the data — the same argument GeoMap makes
          for drawing its graticule at 9% opacity. */}
      {[0, 90, 180, 270].map((b) => {
        const [x, y] = place(R_MAX + 4, b);
        return (
          <line key={b} x1={CX} y1={CY} x2={x} y2={y} stroke={MARK.rule} strokeWidth={1} opacity={0.5} />
        );
      })}

      {/* THE RADIUS, MADE READABLE. Ticks run west, which is the one cardinal
          this corpus's findings leave empty — and if a future corpus fills it,
          they are still the smallest marks on the plot and sit under the
          spoke, not on the data. */}
      {rulerTicks(chart.maxKm, radius).map((km) => {
        const r = radius(km);
        return (
          <g key={km}>
            <line
              x1={CX - r}
              y1={CY - 3}
              x2={CX - r}
              y2={CY + 3}
              stroke={MARK.rule}
              strokeWidth={1}
            />
            {/* The number only. Repeating the unit on every tick put "200 km
                50 km 10 km" into 60 pixels of radius, where the labels
                collided and the ruler became the least legible thing on a plot
                it exists to clarify. The unit is stated once, at the end, the
                way an axis title does it. */}
            <text
              x={CX - r}
              y={CY + 13}
              textAnchor="middle"
              className="mono"
              fontSize={8.5}
              fill={MARK.ink}
              opacity={0.85}
            >
              {km >= 1 ? Math.round(km) : km}
            </text>
          </g>
        );
      })}
      <text
        x={CX - R_MAX - 13}
        y={CY + 13}
        textAnchor="end"
        fontSize={8.5}
        fill={MARK.ink}
        opacity={0.7}
      >
        km
      </text>

      {/* The typical distance, unlabelled. It gives the eye a sense of where
          "normal" ends without adding a second number to read; the section's
          fact strip already states it, and a label here would land inside the
          cluster it describes. */}
      <circle cx={CX} cy={CY} r={rTyp} fill="none" stroke={MARK.rule} strokeWidth={1} opacity={0.9} />

      {/* THE FLAG LINE. The one ring that is labelled, because it is the only
          one a reader has to know to interpret the plot: everything outside it
          is a finding. Dashed so it reads as a threshold rather than as data. */}
      <circle
        cx={CX}
        cy={CY}
        r={rCut}
        fill="none"
        stroke={MARK.flagged}
        strokeWidth={1}
        strokeDasharray="3 3"
        opacity={0.55}
      />
      <text
        x={CX}
        y={CY - rCut - 5}
        textAnchor="middle"
        className="mono"
        fontSize={9.5}
        fill={MARK.flagged}
        opacity={0.85}
      >
        {formatKm(chart.cutoffKm)}
      </text>

      {/* The centre the whole measure is relative to. */}
      <g stroke={MARK.ink} strokeWidth={1} opacity={0.55}>
        <line x1={CX - 4} y1={CY} x2={CX + 4} y2={CY} />
        <line x1={CX} y1={CY - 4} x2={CX} y2={CY + 4} />
      </g>

      {/* PATTERN TIES. Drawn before the marks so a tie never sits on top of the
          point it connects. An arc at constant radius is drawn ONLY when the
          members really are at the same radius — that is the shape of "same
          distance, different direction" and drawing it for findings at
          different distances would be a picture of something untrue. Anything
          else gets a straight tie, which claims only "these two are related". */}
      {patterns.map((pattern) => {
        const members = pattern.memoryIds
          .map((id) => chart.points.find((p) => p.memoryIds.includes(id)))
          .filter((p): p is NonNullable<typeof p> => p !== undefined);
        if (members.length < 2) return null;
        const radii = members.map((m) => m.km);
        const lo = Math.min(...radii);
        const hi = Math.max(...radii);
        const sameRing = hi > 0 && (hi - lo) / hi <= 0.05;
        const key = pattern.memoryIds.join("|");

        if (sameRing && members.length === 2) {
          const r = (radius(members[0].km) + radius(members[1].km)) / 2;
          let [a, b] = members;
          let sweep = (b.bearing - a.bearing + 360) % 360;
          if (sweep > 180) {
            [a, b] = [b, a];
            sweep = 360 - sweep;
          }
          const [x1, y1] = place(r, a.bearing);
          const [x2, y2] = place(r, b.bearing);
          // The arc's own caption. Without it the tie reads as decoration; with
          // it, the pattern is stated at the place the eye is already looking,
          // and the reader never has to reach the list to learn that these two
          // findings are one. It says what the geometry shows and no more —
          // that they are the same distance out — and leaves the cause to the
          // evidence line under the group.
          const [lx, ly] = place(r + 13, a.bearing + sweep / 2);
          return (
            <g key={key}>
              <path
                d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`}
                fill="none"
                stroke={MARK.flagged}
                strokeWidth={1.5}
                // Heavier than a hairline dot pattern: at 1px on a 3px gap the
                // tie read as part of the ring system rather than as a
                // deliberate connector between two findings, which is the one
                // thing on this plot the reader is most likely to miss.
                strokeDasharray="2.5 3"
                strokeLinecap="round"
                opacity={0.85}
              />
              <text
                x={lx}
                y={ly}
                textAnchor={lx >= CX ? "start" : "end"}
                fontSize={9}
                fill={MARK.flagged}
                opacity={0.9}
              >
                same distance
              </text>
            </g>
          );
        }

        return (
          <g key={key}>
            {members.slice(1).map((m, i) => {
              const [x1, y1] = place(radius(members[i].km), members[i].bearing);
              const [x2, y2] = place(radius(m.km), m.bearing);
              return (
                <line
                  key={m.memoryIds[0]}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={MARK.flagged}
                  strokeWidth={1.25}
                  strokeDasharray="1 3"
                  strokeLinecap="round"
                  opacity={0.75}
                />
              );
            })}
          </g>
        );
      })}

      {/* The ordinary memories. Area encodes how many share the position — a
          berth holding twelve draws as one mark of twelve, never as one mark,
          and never as twelve jittered marks at coordinates the corpus does not
          contain. Area rather than radius because area is what the eye
          actually compares. */}
      {baseline.map((p) => {
        const n = p.memoryIds.length;
        const r = Math.min(8, 2.2 * Math.sqrt(n));
        const [x, y] = place(radius(p.km), p.bearing);
        return (
          <g key={p.memoryIds[0]}>
            <circle cx={x} cy={y} r={r} fill={MARK.baseline} opacity={0.45} />
            {r >= 6 ? (
              <text
                x={x}
                y={y + 2.6}
                textAnchor="middle"
                className="mono"
                fontSize={7.5}
                fill="var(--background)"
                opacity={0.95}
              >
                {n}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* The findings. Four encodings deep before colour is asked to do
          anything: outside the drawn ring, larger, haloed, and carrying their
          own distance as a direct label. */}
      {flagged.map((p) => {
        const id = p.memoryIds[0];
        const isSelected = p.memoryIds.some((m) => m === selectedId);
        const [x, y] = place(radius(p.km), p.bearing);
        const right = x >= CX;
        const colour = isSelected ? MARK.selected : MARK.flagged;
        return (
          <g
            key={id}
            onClick={() => select(id)}
            className="cursor-pointer"
            // The list below is the keyboard path to these same memories, so
            // the mark carries a pointer affordance and a hover title only.
            // See PlotFrame for why it is not separately focusable.
          >
            <title>{`${formatKm(p.km)} from the cluster centre, bearing ${Math.round(p.bearing)}°`}</title>
            <circle cx={x} cy={y} r={9} fill={colour} opacity={isSelected ? 0.3 : 0.16} />
            <circle
              cx={x}
              cy={y}
              r={4.4}
              fill={colour}
              stroke="var(--background)"
              strokeWidth={1.1}
            />
            <text
              x={right ? x + 9 : x - 9}
              y={y + 3.4}
              textAnchor={right ? "start" : "end"}
              className="mono"
              fontSize={10}
              fill={colour}
            >
              {formatKm(p.km)}
            </text>
          </g>
        );
      })}

      {/* A compass rose in the margin rather than letters on the rim: at this
          corpus's bearings a rim label would land under the 259 km mark. */}
      <g transform="translate(132, 60)" opacity={0.75}>
        <line x1={0} y1={-11} x2={0} y2={11} stroke={MARK.rule} strokeWidth={1} />
        <line x1={-11} y1={0} x2={11} y2={0} stroke={MARK.rule} strokeWidth={1} />
        <text x={0} y={-14} textAnchor="middle" fontSize={8} fill={MARK.ink}>
          N
        </text>
        <text x={15} y={3} textAnchor="middle" fontSize={8} fill={MARK.ink}>
          E
        </text>
        <text x={0} y={21} textAnchor="middle" fontSize={8} fill={MARK.ink}>
          S
        </text>
        <text x={-15} y={3} textAnchor="middle" fontSize={8} fill={MARK.ink}>
          W
        </text>
      </g>
    </PlotFrame>
  );
}
