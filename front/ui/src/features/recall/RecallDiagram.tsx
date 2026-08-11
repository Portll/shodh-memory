import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * How recall works — the signature element of this product, at hero scale.
 *
 * Three problems solved at once. The stage is dead space until the graph canvas
 * is mounted, and a raw `Failed to fetch` is otherwise the first thing anyone
 * sees. The vocabulary this product needs — spreading activation, provenance —
 * cannot go in the chrome without turning it into jargon. And the one thing
 * that distinguishes shodh from a vector store is a mechanism, not a number:
 * activation propagates along learned relations, so a memory nobody searched
 * for still surfaces.
 *
 * So the mechanism is drawn, and it moves. The pulses travelling the edges are
 * the propagation itself, staggered outward by hop distance from the cue —
 * the animation is the claim, which is why it is here and why there is nothing
 * else animated on the screen.
 *
 * Numbering is used because the content genuinely is a sequence: a cue is
 * required before activation spreads, which is required before anything is
 * ranked, which is required before it can be traced. Each step keeps its name
 * visible at all times so the whole thing reads at a glance; only the
 * explanation is disclosed, on hover or focus. Every region is a real focusable
 * control, so this works from the keyboard and reads to a screen reader.
 */

type PartId = "cue" | "spread" | "surfaced" | "provenance";

const PARTS: {
  id: PartId;
  step: string;
  label: string;
  detail: string;
}[] = [
  {
    id: "cue",
    step: "01",
    label: "Your cue",
    detail:
      "A few words are enough. Recall does not need the phrasing that was originally stored — it starts from meaning, not from matching text.",
  },
  {
    id: "spread",
    step: "02",
    label: "Activation spreads",
    detail:
      "The cue lights up whatever it touches, and that activation travels along learned relations to neighbours. This is how a memory nobody searched for still surfaces.",
  },
  {
    id: "surfaced",
    step: "03",
    label: "What surfaced",
    detail:
      "The memories that ended up most activated, ranked. Not just the closest match — the ones the rest of the graph agreed were relevant.",
  },
  {
    id: "provenance",
    step: "04",
    label: "Where it came from",
    detail:
      "Every surfaced memory traces back to the session that recorded it, with a timestamp. Nothing here is generated; it is retrieved, so it can always be checked.",
  },
];

const MONO = '"Berkeley Mono", "SF Mono", ui-monospace, Consolas, monospace';

/** Graph edges, with the hop distance from the cue that staggers the pulse. */
const EDGES: { a: [number, number]; b: [number, number]; hop: number }[] = [
  { a: [206, 130], b: [278, 74], hop: 0 },
  { a: [206, 130], b: [286, 130], hop: 0 },
  { a: [206, 130], b: [272, 186], hop: 0 },
  { a: [278, 74], b: [356, 96], hop: 1 },
  { a: [286, 130], b: [356, 96], hop: 1 },
  { a: [286, 130], b: [350, 168], hop: 1 },
  { a: [272, 186], b: [350, 168], hop: 1 },
];

const NODES: { at: [number, number]; r: number; hop: number }[] = [
  { at: [206, 130], r: 7, hop: 0 },
  { at: [278, 74], r: 5.5, hop: 1 },
  { at: [286, 130], r: 6, hop: 1 },
  { at: [272, 186], r: 5, hop: 1 },
  { at: [356, 96], r: 5, hop: 2 },
  { at: [350, 168], r: 4.5, hop: 2 },
];

const len = ([x1, y1]: [number, number], [x2, y2]: [number, number]) =>
  Math.hypot(x2 - x1, y2 - y1);

/**
 * One focusable region.
 *
 * `hit` is not optional and not cosmetic. An SVG `<g>` has no area of its own —
 * pointer events land only on the strokes and fills inside it, and most of what
 * is drawn here is 1px lines and 5px circles. Without a transparent hit
 * rectangle the caption invites you to point at a part and then asks you to hit
 * a hairline. `fill="transparent"` is required rather than `fill="none"`, which
 * is not a paint and therefore takes no pointer events at all.
 */
function Hotspot({
  part,
  active,
  dimmed,
  hit,
  onEnter,
  onLeave,
  children,
}: {
  part: (typeof PARTS)[number];
  active: boolean;
  dimmed: boolean;
  hit: { x: number; y: number; w: number; h: number };
  onEnter: () => void;
  onLeave: () => void;
  children: React.ReactNode;
}) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${part.label}. Step ${part.step} of 4.`}
      aria-pressed={active}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEnter();
        }
        if (e.key === "Escape") onLeave();
      }}
      className={cn(
        "cursor-pointer outline-none transition-opacity duration-300",
        dimmed ? "opacity-25" : "opacity-100",
      )}
    >
      {/* Never drawn. Outlining it boxes the illustration into four rectangles
          that read louder than the thing being revealed; the accent and the
          dimming of everything else already say which part is selected. The
          focus ring is drawn on the step number instead, where it has an edge
          to sit on. */}
      <rect {...{ x: hit.x, y: hit.y, width: hit.w, height: hit.h }} fill="transparent" />

      <text
        x={hit.x + 2}
        y={hit.y + 13}
        fill={active ? "var(--primary)" : "var(--muted-foreground)"}
        fontFamily={MONO}
        fontSize="10.5"
        letterSpacing="0.08em"
        className="transition-[fill] duration-200"
      >
        {part.step}
      </text>
      <text
        x={hit.x + 26}
        y={hit.y + 13}
        fill={active ? "var(--foreground)" : "var(--muted-foreground)"}
        fontSize="11.5"
        letterSpacing="-0.01em"
        className="transition-[fill] duration-200"
      >
        {part.label}
      </text>

      {children}
    </g>
  );
}

export function RecallDiagram() {
  const [active, setActive] = useState<PartId | null>(null);
  const shown = PARTS.find((p) => p.id === active);
  const dim = (id: PartId) => active !== null && active !== id;

  const accent = "var(--primary)";
  const line = "var(--border)";
  const wire = "#2b2d31";
  const idle = "#3a3d43";

  // Motion runs only while nothing is selected. Once someone is reading one
  // step, pulses crossing the other three are competing for the attention they
  // just gave it.
  const flowing = active === null;

  return (
    <div className="flex w-full max-w-4xl flex-col items-center gap-8">
      <svg
        viewBox="0 0 720 268"
        className="w-full"
        role="group"
        aria-label="How recall works, in four steps. Each step explains itself on hover or focus."
      >
        {/* ── 01 · the cue ─────────────────────────────────────────── */}
        <Hotspot
          part={PARTS[0]}
          active={active === "cue"}
          dimmed={dim("cue")}
          hit={{ x: 8, y: 88, w: 180, h: 84 }}
          onEnter={() => setActive("cue")}
          onLeave={() => setActive(null)}
        >
          <rect
            x="10"
            y="112"
            width="140"
            height="36"
            rx="8"
            fill="var(--card)"
            stroke={active === "cue" ? accent : line}
            strokeWidth="1"
            className="transition-[stroke] duration-200"
          />
          <circle cx="30" cy="130" r="4.5" fill="none" stroke={idle} strokeWidth="1.4" />
          <line x1="33.5" y1="133.5" x2="36" y2="136" stroke={idle} strokeWidth="1.4" strokeLinecap="round" />
          <rect x="48" y="126" width="76" height="4" rx="2" fill={idle} />
          <line
            x1="150"
            y1="130"
            x2="199"
            y2="130"
            stroke={active === "cue" ? accent : wire}
            strokeWidth="1.25"
            className="transition-[stroke] duration-200"
          />
        </Hotspot>

        {/* ── 02 · spreading activation ────────────────────────────── */}
        <Hotspot
          part={PARTS[1]}
          active={active === "spread"}
          dimmed={dim("spread")}
          hit={{ x: 196, y: 30, w: 190, h: 178 }}
          onEnter={() => setActive("spread")}
          onLeave={() => setActive(null)}
        >
          {EDGES.map((e, i) => (
            <line
              key={`w${i}`}
              x1={e.a[0]}
              y1={e.a[1]}
              x2={e.b[0]}
              y2={e.b[1]}
              stroke={active === "spread" ? accent : wire}
              strokeWidth="1"
              className="transition-[stroke] duration-200"
            />
          ))}

          {/* The travelling pulse. A separate stroke over each edge so the
              resting wire stays visible underneath it. */}
          {flowing
            ? EDGES.map((e, i) => {
                const span = len(e.a, e.b) + 90;
                return (
                  <line
                    key={`p${i}`}
                    x1={e.a[0]}
                    y1={e.a[1]}
                    x2={e.b[0]}
                    y2={e.b[1]}
                    stroke={accent}
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeDasharray={`7 ${span}`}
                    style={{
                      ["--flow-span" as string]: `${span + 7}`,
                      animation: `shodh-activation-flow 2.4s ${e.hop * 0.42}s linear infinite`,
                    }}
                  />
                );
              })
            : null}

          {NODES.map((n, i) => (
            <g key={`n${i}`}>
              {flowing ? (
                <circle
                  cx={n.at[0]}
                  cy={n.at[1]}
                  r={n.r + 4}
                  fill={accent}
                  style={{
                    transformBox: "fill-box",
                    transformOrigin: "center",
                    animation: `shodh-node-pulse 2.4s ${n.hop * 0.42}s ease-out infinite`,
                  }}
                  opacity="0"
                />
              ) : null}
              <circle
                cx={n.at[0]}
                cy={n.at[1]}
                r={n.r}
                fill={active === "spread" ? accent : idle}
                className="transition-[fill] duration-200"
              />
            </g>
          ))}
        </Hotspot>

        {/* ── 03 · what surfaced ───────────────────────────────────── */}
        <Hotspot
          part={PARTS[2]}
          active={active === "surfaced"}
          dimmed={dim("surfaced")}
          hit={{ x: 396, y: 52, w: 318, h: 130 }}
          onEnter={() => setActive("surfaced")}
          onLeave={() => setActive(null)}
        >
          <line
            x1="366"
            y1="130"
            x2="446"
            y2="130"
            stroke={active === "surfaced" ? accent : wire}
            strokeWidth="1.25"
            className="transition-[stroke] duration-200"
          />
          {[
            { y: 84, w: 262, o: 1 },
            { y: 118, w: 238, o: 0.78 },
            { y: 152, w: 210, o: 0.56 },
          ].map((c, i) => (
            <g key={c.y} opacity={c.o}>
              <rect
                x="452"
                y={c.y}
                width={c.w}
                height="26"
                rx="6"
                fill="var(--card)"
                stroke={active === "surfaced" ? accent : line}
                strokeWidth="1"
                className="transition-[stroke] duration-200"
              />
              {/* Rank, not a score. A number that looks like a confidence
                  value would be inventing data; an ordinal is what ranking
                  actually produces. */}
              <text
                x="466"
                y={c.y + 17}
                fill={active === "surfaced" ? accent : "var(--muted-foreground)"}
                fontFamily={MONO}
                fontSize="9.5"
                className="transition-[fill] duration-200"
              >
                {i + 1}
              </text>
              <rect x="482" y={c.y + 11} width={c.w - 46} height="4" rx="2" fill={idle} />
            </g>
          ))}
        </Hotspot>

        {/* ── 04 · provenance ──────────────────────────────────────── */}
        <Hotspot
          part={PARTS[3]}
          active={active === "provenance"}
          dimmed={dim("provenance")}
          hit={{ x: 8, y: 196, w: 560, h: 64 }}
          onEnter={() => setActive("provenance")}
          onLeave={() => setActive(null)}
        >
          <path
            d="M560 178 L560 240 L172 240"
            fill="none"
            stroke={active === "provenance" ? accent : wire}
            strokeWidth="1"
            strokeDasharray="3 4"
            className="transition-[stroke] duration-200"
          />
          <rect
            x="52"
            y="226"
            width="120"
            height="28"
            rx="6"
            fill="var(--card)"
            stroke={active === "provenance" ? accent : line}
            strokeWidth="1"
            className="transition-[stroke] duration-200"
          />
          <text
            x="66"
            y={244}
            fill="var(--muted-foreground)"
            fontFamily={MONO}
            fontSize="9.5"
            letterSpacing="0.04em"
          >
            session · when
          </text>
        </Hotspot>
      </svg>

      {/* Docked, at a reserved height, so revealing an explanation never
          reflows the illustration above it. */}
      <div
        className={cn(
          "flex h-[92px] w-full max-w-xl flex-col justify-center rounded-lg px-5 py-3",
          "transition-colors duration-200",
          shown ? "border-border bg-card border" : "border border-transparent",
        )}
      >
        {shown ? (
          <>
            <p className="flex items-baseline gap-2.5">
              <span className="text-primary mono text-[10.5px] tracking-[0.08em]">
                {shown.step}
              </span>
              <span className="text-[13px] font-medium tracking-tight">
                {shown.label}
              </span>
            </p>
            <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
              {shown.detail}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground/60 text-center text-[12px]">
            How recall works — point at any step to see what it does.
          </p>
        )}
      </div>
    </div>
  );
}
