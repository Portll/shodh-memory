import { cn } from "@/lib/utils";

/**
 * Not Radix ScrollArea. That component exists to draw custom scrollbar
 * thumbs; this app already themes the native ones globally
 * (`::-webkit-scrollbar*` in index.css), so a Radix dependency would buy a
 * capability this app does not need — exactly the "styled div" case the
 * brief says not to add a package for.
 *
 * Deliberately does not assume `flex-1`. `ResultList.tsx` scrolls as a flex
 * child (needs `min-h-0 flex-1`); `Inspector.tsx` scrolls inside an
 * absolutely-positioned `<aside>` with a fixed top/bottom (neither applies,
 * and `flex-1` on a non-flex-item is inert but misleading to read). Forcing
 * one layout's classes onto both would be wrong at one of the two real call
 * sites, so this owns only the overflow behaviour and callers compose the
 * rest — which is also where the actual reminder belongs: a flex child with
 * no explicit `min-h-0` does not scroll, it grows its parent instead.
 */
export function ScrollArea({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("overflow-y-auto", className)} {...props} />;
}
