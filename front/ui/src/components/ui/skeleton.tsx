import { cn } from "@/lib/utils";

/** `prefers-reduced-motion` needs no branch here — the global rule in
 *  index.css already collapses `animate-pulse` to a static state. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("bg-muted animate-pulse rounded-md", className)}
      {...props}
    />
  );
}
