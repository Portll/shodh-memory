import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The chip style `Inspector.tsx` and `ScoreBreakdown.tsx` were already
 * hand-rolling (`border-border text-muted-foreground rounded border px-1.5
 * py-0.5 text-[10px]`) for entity tags and retrieval-leg sources — that
 * became the `outline` variant here, unchanged, so extracting this primitive
 * does not restyle either surface, only de-duplicates them.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] leading-none whitespace-nowrap",
  {
    variants: {
      variant: {
        outline: "border-border text-muted-foreground",
        secondary: "bg-secondary text-secondary-foreground border-transparent",
        /** Alarm, not accent — `--destructive` is pink-red precisely so it
         *  never converges with the orange chrome. See DIRECTION.md. */
        destructive: "bg-destructive/10 text-destructive border-destructive/30",
        warn: "bg-warn/10 text-warn border-warn/30",
        accent: "bg-primary/10 text-primary border-primary/30",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
