import { cn } from "@/lib/utils";
import type { SeatModelInfo } from "@/lib/seat/types";

/**
 * Where this conversation's content goes — stated wherever the conversation
 * is happening, not in a settings pane someone visited once.
 *
 * The model control decides the single most consequential thing in the app:
 * whether conversation content leaves the machine. Local means nothing
 * leaves; a hosted provider means every turn is transmitted, however it is
 * authenticated. This badge makes that legible at a glance, factually and
 * without alarm — hosted models are a normal choice, so the hosted state is
 * neutral text, not a warning colour. Only "Local" gets a hue (--live, the
 * same green the connection strip uses for "running"), because it is a
 * property worth being able to confirm from across a room in a demo.
 *
 * Renders nothing for an unresolved model: no badge is honest, a guessed one
 * is not.
 */
export function EgressBadge({ info }: { info: SeatModelInfo | null }) {
  if (!info) return null;

  const local = info.billing === "none";
  const label = local ? "Local" : info.billing === "subscription" ? "Plan" : "API";
  const title = local
    ? "Runs on this machine. Conversation content does not leave it."
    : info.billing === "subscription"
      ? `Hosted — each turn is sent to ${info.provider}. Usage counts against your plan; tokens are not billed individually.`
      : `Hosted — each turn is sent to ${info.provider}. Tokens are metered and billed.`;

  return (
    <span
      title={title}
      className={cn(
        "mono flex h-[22px] shrink-0 items-center gap-1.5 rounded border px-1.5 text-[10px]",
        local
          ? "border-[var(--live)]/30 text-[var(--live)]"
          : "border-border text-muted-foreground",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
