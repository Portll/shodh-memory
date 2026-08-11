import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

/** Panel width, and the gap it keeps from the edge of the window. Both are
 *  needed in the clamp below, so neither is a magic number in the class list. */
const PANEL_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

/**
 * The one disclosure affordance in the product, and the only sanctioned place
 * for copy that a returning user should not have to read again.
 *
 * WHY THIS EXISTS. Every screen here had acquired an explanatory paragraph:
 * what the destination is, how a measure works, which mouse gesture zooms. All
 * of it true, none of it worth permanent screen space on an instrument whose
 * users are reading it for the tenth time. Deleting the copy would have cost
 * real information, so it moves one level down instead — the standard
 * progressive-disclosure trade, and deliberately ONE level: NN/g finds designs
 * beyond two disclosure levels have low usability because people lose their
 * place between them. A row still leads to the Inspector; nothing in this
 * product now leads to a third level.
 *
 * WHY IT IS A BUTTON AND NOT A `title` TOOLTIP. Three separate constraints, all
 * of which a hover tooltip fails:
 *
 *  - It has to be reachable without a pointer. Hover-triggered content is
 *    unavailable to keyboard and touch, and WCAG 1.4.13 additionally requires
 *    such content to be dismissible and to stay put while it is being read —
 *    which the native `title` does not do.
 *  - It has to be dismissible. Escape closes it and returns focus, and a click
 *    anywhere else closes it; the panel never traps anyone.
 *  - It has to be able to hold more than a phrase. A native tooltip clips,
 *    delays, and cannot be read at leisure.
 *
 * WHAT MAY GO IN HERE, AND WHAT MAY NOT. This holds MECHANISM — how a measure
 * is computed, what a screen is for, which gesture pans a canvas. It must never
 * hold a CAVEAT that changes how the visible numbers should be read, because
 * NN/g's finding on info tips is blunt: most users never open them. So "the
 * spread fell back to a mean because half the corpus shares one coordinate"
 * stays on screen as a visible token, and only the full explanation of what a
 * robust scale is comes in here. The rule is applied per call site; there is no
 * way to enforce it in the type.
 */
export function InfoHint({
  /** Names the subject, for screen readers: "About Out of place". */
  label,
  children,
  /** Which edge of the button the panel is anchored to. Footers on the right of
   *  a canvas need "right" or the panel renders off the viewport. */
  align = "left",
  /** Which edge it opens toward. Anything docked to the bottom of a canvas
   *  needs "up" for the same reason. */
  side = "down",
  className,
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
  side?: "up" | "down";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  /**
   * WHERE THE PANEL GOES, IN VIEWPORT COORDINATES, IN A PORTAL.
   *
   * The obvious implementation — an absolutely positioned child of the trigger
   * — was built first and was wrong in the browser. Three of the call sites sit
   * inside `overflow-hidden` canvases (GeoView, GraphView, GraphStage all clip
   * so a force layout cannot spill), and on /recall the stage is narrow enough
   * that the panel opened straight through its left edge and was sliced
   * mid-word. Nothing about the trigger's own box can fix that: the clip is an
   * ancestor's, and the panel has to leave the subtree to escape it.
   *
   * So it renders into `document.body` at `position: fixed`, from the trigger's
   * measured rect. `align` and `side` pick the preferred corner; the clamp then
   * keeps the whole panel inside the window, which is what makes the choice at
   * each call site a preference rather than a bet on a viewport width. A panel
   * that would sit below the fold flips above the trigger instead of being
   * pushed up over it.
   *
   * Fixed positioning does not follow a scroll, so a scroll closes it — which
   * is also the behaviour a reader expects from something they opened to read
   * one thing.
   */
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) {
      setPos(null);
      return;
    }
    const t = trigger.current.getBoundingClientRect();
    const height = panel.current.offsetHeight;

    let left = align === "right" ? t.right - PANEL_WIDTH : t.left;
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
    );

    const below = t.bottom + 6;
    const above = t.top - 6 - height;
    const fitsBelow = below + height <= window.innerHeight - VIEWPORT_MARGIN;
    const fitsAbove = above >= VIEWPORT_MARGIN;
    const top =
      side === "up" ? (fitsAbove ? above : below) : fitsBelow ? below : fitsAbove ? above : below;

    setPos({ left, top: Math.max(VIEWPORT_MARGIN, top) });
  }, [open, align, side]);

  useEffect(() => {
    if (!open) return;
    // Pointerdown rather than click: a click that lands on another control
    // should both close this and activate that control, and click ordering
    // makes the second half of that unreliable. The panel is checked as well as
    // the trigger — it is portaled out of the subtree, so `root` no longer
    // contains it and selecting text inside it would otherwise close it.
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Focus goes back to what opened it, or Escape strands the keyboard at
      // the top of the document.
      trigger.current?.focus();
    };
    const dismiss = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Capture, because the scrollers here are inner panes rather than the
    // window and their scroll events do not bubble.
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return (
    // `pointer-events-auto`: several call sites live inside canvas overlays that
    // are `pointer-events-none` so drags reach the map underneath. The trigger
    // has to opt back in or it cannot be clicked at all.
    <span ref={root} className={cn("pointer-events-auto inline-flex", className)}>
      <button
        ref={trigger}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "text-muted-foreground/50 hover:text-foreground focus-visible:ring-ring",
          "inline-flex size-4 shrink-0 items-center justify-center rounded",
          "transition-colors duration-100 focus-visible:ring-2 focus-visible:outline-none",
          open && "text-foreground",
        )}
      >
        <Info aria-hidden="true" className="size-3" strokeWidth={2} />
      </button>

      {open
        ? createPortal(
            <span
              ref={panel}
              id={panelId}
              role="note"
              style={{
                width: PANEL_WIDTH,
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                // Hidden for the one frame between mounting (which is what
                // makes it measurable) and being placed. Without this the
                // panel is briefly visible at the top-left of the window.
                visibility: pos ? "visible" : "hidden",
              }}
              className={cn(
                "border-border bg-popover text-popover-foreground pointer-events-auto fixed z-50",
                "rounded-md border p-2.5 text-[11px] leading-relaxed shadow-xl",
              )}
            >
              {children}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
