import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lifted verbatim from `SearchField.tsx`'s inline classes — the only input in
 * the app before this — rather than from Watermelon's captured
 * `dashboard-content.tsx`, whose search input is styled for a much larger
 * hero search bar (`h-11 rounded-lg bg-muted`). This app's chrome runs at
 * 13px body / 26px status-strip density; matching that beats matching the
 * source verbatim.
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "bg-background border-input placeholder:text-muted-foreground w-full min-w-0",
        "rounded-md border px-2.5 py-1.5 text-[13px]",
        "focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-2 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
