import { cn } from "@/lib/utils";
import { InfoHint } from "./info-hint";

/**
 * The centred title+body message. Before this, `Placeholder.tsx` and
 * `RecallView.tsx`'s `Message` hand-rolled the same shape at two different
 * sizes (`text-[15px]`/`max-w-sm` for a whole destination, `text-[13px]`/
 * `max-w-xs` for the narrower 340px result column) — real drift, not
 * cosmetic duplication, since a size chosen for one context silently leaked
 * into the other whenever someone copied a block. `size` keeps both call
 * sites, `panel` is the narrower default because more callers are panels
 * than whole pages.
 *
 * `body` IS ONE SHORT SENTENCE, AND THE TYPE CANNOT ENFORCE IT. These had grown
 * to two and three sentences apiece — a state, its cause, and a mechanism
 * explaining the cause — which is documentation standing in the middle of a
 * screen someone arrived at by accident. The state and what to do about it stay
 * in `body`; the mechanism moves to `more`, which is the same click-to-open
 * affordance the rest of the product uses for read-once copy. An empty state is
 * the one place a reader has nothing else to do, so the detail must remain
 * reachable — it just must not be the first thing on screen.
 */
export function EmptyState({
  title,
  body,
  more,
  size = "panel",
  className,
}: {
  title: string;
  body: string;
  /** Mechanism: why this state exists, what produces the data when it does.
   *  Never the state itself, and never a remedy the reader has to act on. */
  more?: string;
  size?: "panel" | "page";
  className?: string;
}) {
  return (
    <div className={cn("grid h-full place-items-center", size === "page" ? "px-8" : "px-6", className)}>
      <div className={cn("text-center", size === "page" ? "max-w-sm" : "max-w-xs")}>
        <p
          className={cn(
            "font-medium tracking-tight",
            size === "page" ? "text-[15px]" : "text-[13px]",
          )}
        >
          {title}
        </p>
        <p
          className={cn(
            "text-muted-foreground leading-relaxed",
            size === "page" ? "mt-2 text-[13px]" : "mt-1.5 text-[12px]",
          )}
        >
          {body}
          {more ? (
            // Inline with the last word rather than on its own row: a centred
            // block with a lone icon underneath reads as an unlabelled button.
            <InfoHint label={title} className="ml-1.5 translate-y-[1px] text-left">
              {more}
            </InfoHint>
          ) : null}
        </p>
      </div>
    </div>
  );
}
