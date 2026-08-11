import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * `size` is a real Watermelon addition, not stock shadcn — confirmed from
 * the captured source: `<Card size="sm" className="h-full gap-11 ...">` in
 * `dashboard-content.tsx`. Flat by default (border, no shadow): index.css's
 * documented discipline is "no gradients on surfaces", and shadows read the
 * same way here — the rest of the chrome (Sidebar, Inspector, TopBar) draws
 * depth with hairline borders only, never elevation.
 */
const cardVariants = cva("bg-card text-card-foreground border-border flex flex-col rounded-lg border", {
  variants: {
    size: {
      default: "gap-4 p-4",
      sm: "gap-3 p-3",
    },
  },
  defaultVariants: { size: "default" },
});

export function Card({
  className,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ size }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      className={cn("text-[12px] font-medium tracking-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-muted-foreground text-[11px] leading-relaxed", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn(className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("border-border flex items-center border-t pt-3", className)}
      {...props}
    />
  );
}
