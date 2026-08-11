import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { deleteConversation, renameConversation } from "@/lib/seat/client";
import type { ConversationSummary } from "@/lib/seat/types";
import { formatCost, formatTokens, relativeDay } from "@/lib/format";
import { costIsReal, useBillingLookup } from "./useBilling";
import { useChat } from "@/stores/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The session column. Every number on a row is real: title from the first
 * user message (or user rename), model from the conversation row, turn count
 * and token/cost totals accumulated by the seat's store from pi usage events.
 *
 * Rename and delete act on real endpoints (PATCH / DELETE
 * /seat/v1/conversations/{id}); delete is two-step in place rather than a
 * modal — the confirmation appears where the click happened.
 */

function SessionRow({
  session,
  active,
  onOpen,
}: {
  session: ConversationSummary;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const forget = useChat((s) => s.forget);
  const [mode, setMode] = useState<"idle" | "rename" | "confirm-delete">("idle");
  const [draft, setDraft] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["seat-sessions", session.user_id] });

  const rename = useMutation({
    mutationFn: (title: string) => renameConversation(session.conversation_id, title),
    onSuccess: () => {
      setMode("idle");
      void invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteConversation(session.conversation_id),
    onSuccess: () => {
      forget(session.conversation_id);
      void invalidate();
    },
  });

  const title = session.title ?? `Untitled · ${relativeDay(session.created_at)}`;
  // Same rule as the conversation header: under a subscription, pi's cost
  // number is a list-price estimate of flat-rate usage, not a bill. This row
  // was the one surface the billing-aware pass missed — caught the first time
  // a real Max-plan conversation appeared in the list showing "$0.011".
  const lookupModel = useBillingLookup(true);
  const cost = costIsReal(lookupModel(session.model))
    ? formatCost(session.usage.cost_total)
    : null;

  if (mode === "rename") {
    return (
      <form
        className="border-border flex items-center gap-1 border-b px-2 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) rename.mutate(draft.trim());
        }}
      >
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMode("idle");
          }}
          aria-label="Conversation title"
          className="h-7 text-[12px]"
        />
        <Button type="submit" size="icon" variant="ghost" aria-label="Save title" disabled={rename.isPending}>
          <Check />
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label="Cancel rename" onClick={() => setMode("idle")}>
          <X />
        </Button>
      </form>
    );
  }

  return (
    <div
      className={cn(
        "group border-border relative border-b transition-colors duration-100",
        active ? "bg-primary/10" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(session.conversation_id)}
        aria-current={active ? "true" : undefined}
        className="focus-visible:ring-ring w-full px-3 py-2.5 text-left focus-visible:-outline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        <p className={cn("truncate text-[12px]", active ? "text-foreground" : "text-foreground/90")}>
          {title}
        </p>
        <p className="text-muted-foreground mono mt-1 flex items-center gap-2 text-[10px]">
          <span className="truncate">{session.model.name}</span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">{formatTokens(session.usage.total_tokens)} tok</span>
          {cost ? (
            <>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{cost}</span>
            </>
          ) : null}
          <span className="ml-auto shrink-0">{relativeDay(session.updated_at)}</span>
        </p>
      </button>

      {mode === "confirm-delete" ? (
        <div className="bg-popover border-border absolute inset-y-0 right-0 z-10 flex items-center gap-1 border-l px-2">
          <span className="text-destructive text-[11px]">Delete?</span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Confirm delete"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Check />
          </Button>
          <Button size="icon" variant="ghost" aria-label="Cancel delete" onClick={() => setMode("idle")}>
            <X />
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            "absolute top-1.5 right-1.5 hidden items-center gap-0.5",
            "group-hover:flex group-focus-within:flex",
          )}
        >
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Rename "${title}"`}
            className="size-6"
            onClick={() => {
              setDraft(session.title ?? "");
              setMode("rename");
            }}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Delete "${title}"`}
            className="size-6"
            onClick={() => setMode("confirm-delete")}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function SessionList({
  sessions,
  activeId,
  onOpen,
  onNew,
}: {
  sessions: ConversationSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex h-10 shrink-0 items-center justify-between border-b pr-1.5 pl-3">
        <span className="text-muted-foreground text-[11px] tracking-wide uppercase">Sessions</span>
        <Button size="sm" variant="ghost" onClick={onNew} aria-label="New conversation">
          <Plus /> New
        </Button>
      </div>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground px-3 py-4 text-[12px] leading-relaxed">
          No conversations yet for this profile. Start one — every turn will
          show what memory it recalled and why.
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {sessions.map((session) => (
            <SessionRow
              key={session.conversation_id}
              session={session}
              active={session.conversation_id === activeId}
              onOpen={onOpen}
            />
          ))}
        </ScrollArea>
      )}
    </div>
  );
}
