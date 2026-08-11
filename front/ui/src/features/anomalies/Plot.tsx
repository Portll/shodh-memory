import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The frame every anomaly graphic sits in, and the accessibility contract that
 * comes with it.
 *
 * SVG, NOT CANVAS, AND FOR A DIFFERENT REASON THAN GEO. GeoMap.tsx draws to a
 * canvas because it paints a 177-country basemap under a zoom behaviour, where
 * a retained-mode tree of tens of thousands of path nodes would cost more than
 * it returns. These graphics plot at most a few dozen static marks with no
 * basemap and no zoom, so the tradeoff inverts: SVG marks are real DOM, which
 * means they take `<title>` elements, CSS transitions and hit-testing for
 * free, and — the part that actually decides it — they survive a screenshot at
 * any device pixel ratio without the manual dpr bookkeeping canvas needs.
 *
 * THE TEXT EQUIVALENT IS THE POINT OF THIS COMPONENT. A plot that communicates
 * only visually fails the "one look" test for someone who cannot see it, so
 * every graphic here carries `summary` — one sentence stating what the plot
 * shows, with the numbers in it. It is rendered twice: into the SVG's `<desc>`
 * for assistive technology, and as a VISIBLE caption under the plot, because a
 * sentence that tells a sighted reader "32 of 36 sit within 9.5 km" is not a
 * concession to accessibility, it is the fastest way for anyone to confirm
 * that what they think they are seeing is what is there.
 *
 * The marks themselves are `role="img"` and not focusable. That is the rule
 * this codebase already set in GeoMap.tsx:313-325 — a plot may be pointer-only
 * when a column of real buttons beside it reaches the same objects — and here
 * the findings list under every plot is exactly that column. Making the marks
 * focusable AS WELL would put every point in the tab order twice, which is a
 * worse keyboard experience than one clean path, not a better one.
 */
export function PlotFrame({
  /** Names what is plotted. Read by assistive technology, never shown — the
   *  section heading above it already says this to a sighted reader. */
  title,
  /** One sentence, with numbers, stating what the plot shows. Shown AND read. */
  summary,
  /** The plot's aspect, as viewBox units. Marks are authored in this space and
   *  the frame scales them to whatever width the column gives it. */
  viewBox,
  className,
  children,
}: {
  title: string;
  summary: string;
  viewBox: string;
  className?: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const descId = useId();

  return (
    <figure className={cn("px-4 pt-3 pb-2", className)}>
      <svg
        viewBox={viewBox}
        // Width-filling with a preserved aspect: the column is 640px at 1440
        // and around 470px at 1024, and a plot that reflowed its geometry
        // between the two would need its own layout pass at every breakpoint.
        // Scaling one authored composition keeps the marks in the same
        // relationship to each other at every width.
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full"
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{summary}</desc>
        {children}
      </svg>
      <figcaption className="text-muted-foreground/80 mt-1.5 text-[11px] leading-relaxed">
        {summary}
      </figcaption>
    </figure>
  );
}

/**
 * The two states a mark can be in, as tokens rather than literals.
 *
 * These names are the ones index.css already settled, and the settlement is
 * worth restating because it is the reason this screen does not invent a
 * palette. `--node-anomalous` is the pink-red reserved for "deviates from
 * baseline"; `--node-active` is the orange accent reserved for "this is the
 * current selection". They are deliberately different hues so an alarm and a
 * focus ring never read as each other.
 *
 * COLOUR IS NEVER THE ONLY DIFFERENCE. Every flagged mark in these plots is
 * also further out than the drawn cutoff, drawn larger, and carries its own
 * value as a direct label. A reader who cannot separate the two hues still
 * sees position, size and a number, which is three encodings deep before
 * colour is asked to do anything.
 */
export const MARK = {
  baseline: "var(--muted-foreground)",
  flagged: "var(--node-anomalous)",
  selected: "var(--node-active)",
  rule: "var(--border)",
  ink: "var(--muted-foreground)",
} as const;
