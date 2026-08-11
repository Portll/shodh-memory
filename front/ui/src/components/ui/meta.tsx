import { Fragment } from "react";
import { cn } from "@/lib/utils";

/**
 * A row of facts, separated by middots.
 *
 * The unit of copy on this product's status surfaces is the TOKEN, not the
 * sentence. `36 located · 13 matched` is read at a glance and re-read at no
 * cost; "13 of the 36 placed memories matched this search" is read once,
 * carefully, and then skipped forever after. Every heading, footer and status
 * line here that used to be a clause is now a list of these.
 *
 * The separators are rendered rather than typed into the strings for two
 * reasons. Callers assemble their tokens conditionally — a matched count only
 * exists once a search has run — and string concatenation around optional parts
 * is exactly how a strip ends up starting with a stray "·". And a separator
 * that is real markup can be `aria-hidden`, so a screen reader reads three
 * facts rather than "36 located middot 13 matched".
 *
 * Falsy children are dropped, so a call site can pass a conditional straight in
 * without guarding the separator itself.
 */
export function Meta({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const items = (Array.isArray(children) ? children : [children]).flat(Infinity).filter(Boolean);

  return (
    <span className={cn("text-muted-foreground inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]", className)}>
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/35 select-none">
              ·
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">{item}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A measured quantity inside a `Meta` row: the number in the mono face, the
 * word for what it counts in the text face.
 *
 * The split is what makes a strip scannable vertically as well as horizontally
 * — the eye finds the digits without reading the labels, which is the whole
 * argument for right-aligning numerics in a dense table and applies just as
 * well to a row of them. `value` first because the number is the thing being
 * looked for; the label qualifies it.
 */
export function Stat({ value, label }: { value: React.ReactNode; label?: string }) {
  return (
    <>
      <span className="mono text-foreground/85">{value}</span>
      {label ? <span>{label}</span> : null}
    </>
  );
}
