import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Button — the one primitive every clickable surface in this app should
 * converge on, so focus rings, radii and disabled states stop drifting
 * between files.
 *
 * No `asChild`/Radix Slot. Nothing in this app renders a Button as a link or
 * needs polymorphic composition — Sidebar's nav items are `NavLink` with
 * their own bespoke markup (deliberately untouched), and every other trigger
 * here is a real `<button>`. Adding a dependency for a capability with zero
 * call sites would contradict the "net new dependencies: zero" premise this
 * port is built on.
 *
 * `icon-lg` is Watermelon's own addition (`buttonVariants({ size: "icon-lg"
 * })` in the captured `app-sidebar.tsx`, holding 20–24px icons) — kept for
 * parity even though nothing in this port currently consumes it, since
 * Sidebar.tsx is off-limits to restructure and TopBar has no icon buttons
 * yet. Sized against the icons Watermelon paired it with, not guessed at a
 * round number.
 */

const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium",
    "transition-colors duration-100 outline-none",
    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-input bg-background hover:bg-accent hover:text-foreground border",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 [&_svg]:size-4",
        sm: "h-7 gap-1 px-2.5 text-[12px] [&_svg]:size-3.5",
        lg: "h-9 px-4 [&_svg]:size-4",
        icon: "size-8 [&_svg]:size-4",
        /** Watermelon's larger touch target — see file header. */
        "icon-lg": "size-11 [&_svg]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { buttonVariants };
