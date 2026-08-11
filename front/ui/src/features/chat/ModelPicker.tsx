import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { listModels } from "@/lib/seat/client";
import type { ModelRef, SeatModelInfo } from "@/lib/seat/types";
import { formatContext } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

/**
 * The model control — always attached to ONE conversation, never global.
 * A global picker is how someone switches for one question and silently runs
 * every later conversation on the wrong model; keeping the control inside the
 * conversation header puts the switch where its consequence is.
 *
 * The list is real: GET /seat/v1/models returns only models whose providers
 * currently hold working auth (pi's getAvailable), plus whatever the local
 * endpoints report. Opening the picker re-probes Ollama/LM Studio so a model
 * pulled a minute ago shows up without restarting anything.
 *
 * Combobox pattern by hand: a filter input over a listbox with arrow-key
 * navigation. Radix would bring this prebuilt, but this is the only popover
 * in the app and the dependency's cost is the whole point of the "zero net
 * new chrome dependencies" line this UI holds.
 *
 * The footer states what a SWAP does, while the choice is still being made —
 * this control is the one moment the product's strongest property is on
 * screen, and it was previously unsaid there. It is a guarantee, not a
 * slogan: PATCH /v1/conversations/{id}/model reassigns the model and nothing
 * else (seat/src/conversation.ts setModel writes `agent.state.model`, leaving
 * `agent.state.messages` untouched; seat/src/store.ts setModel UPDATEs the
 * three model columns, never the transcripts or events tables), and on this
 * side stores/chat.ts setModel replaces `model` and carries `turns` — where
 * the retrieved memories live — through unchanged.
 *
 * Scope is deliberate and load-bearing. It says memories ALREADY retrieved,
 * because every later turn runs a fresh proactive pass and the new model
 * chooses its own recall cues: "a different model retrieves the same
 * memories" is not something this code guarantees, so it is not said.
 *
 * `swap` gates it, because this same picker also opens on the new-conversation
 * screen, where nothing has been retrieved for the sentence to be about. There
 * it is a first choice, not a switch, and NewConversation says so itself.
 */
export function ModelPicker({
  current,
  disabled,
  swap,
  onSelect,
}: {
  current: ModelRef | null;
  disabled?: boolean;
  /** This picker changes the model of a conversation already under way. */
  swap?: boolean;
  /** Resolves when the seat accepted the change; rejections surface inline. */
  onSelect: (model: SeatModelInfo) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // refetchOnMount + a probe of the local endpoints each time it opens: the
  // catalog is cheap and locally mutable (ollama pull), so opening is the
  // natural refresh point.
  const { data, isFetching } = useQuery({
    queryKey: ["seat-models", open],
    queryFn: ({ signal }) => listModels(open, signal),
    enabled: open,
    staleTime: 30_000,
  });

  const models = useMemo(() => {
    const all = data?.models ?? [];
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? all.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) ||
            model.name.toLowerCase().includes(needle) ||
            model.provider.toLowerCase().includes(needle),
        )
      : all;
    // Group by provider, providers alphabetical, models in catalog order.
    const groups = new Map<string, SeatModelInfo[]>();
    for (const model of filtered) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data, filter]);

  const flat = useMemo(() => models.flatMap(([, group]) => group), [models]);

  useEffect(() => {
    if (open) {
      setFilter("");
      setActiveIndex(0);
      setError(null);
      // Focus after the popover paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Click-away.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const choose = async (model: SeatModelInfo) => {
    try {
      await onSelect(model);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={current ? `Model: ${current.name}. Change model` : "Choose model"}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px]",
          "border-border bg-card hover:bg-accent transition-colors duration-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <Cpu aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
        <span className="max-w-[180px] truncate">
          {current ? current.name : "Choose model"}
        </span>
        {current ? (
          <span className="text-muted-foreground mono hidden text-[10px] sm:inline">
            {current.provider}
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />
      </button>

      {open ? (
        <div
          className={cn(
            "border-border bg-popover absolute right-0 z-40 mt-1 w-[320px] max-w-[calc(100vw-2rem)]",
            "flex max-h-[420px] flex-col overflow-hidden rounded-lg border shadow-2xl shadow-black/50",
          )}
        >
          <div className="border-border border-b p-2">
            <Input
              ref={inputRef}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const model = flat[activeIndex];
                  if (model) void choose(model);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="Filter models…"
              aria-label="Filter models"
            />
          </div>

          <ul ref={listRef} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto p-1">
            {flat.length === 0 ? (
              <li className="text-muted-foreground px-3 py-4 text-[12px]">
                {isFetching
                  ? "Listing models…"
                  : data && data.models.length === 0
                    ? "No models available. Add a provider key under Providers, or start Ollama / LM Studio."
                    : "Nothing matches that filter."}
              </li>
            ) : (
              models.map(([provider, group]) => (
                <li key={provider}>
                  {/* The mark sits on the GROUP header rather than on every
                      row: the rows under it all share the provider, so per-row
                      logos would repeat the same glyph down the list and add
                      noise instead of information. */}
                  <div className="text-muted-foreground/70 flex items-center gap-1.5 px-2 pt-2 pb-1 text-[10px] tracking-wide uppercase">
                    <ProviderLogo provider={provider} className="size-3" />
                    {provider}
                  </div>
                  <ul>
                    {group.map((model) => {
                      const index = flat.indexOf(model);
                      const isCurrent =
                        current?.provider === model.provider && current?.id === model.id;
                      return (
                        <li key={`${model.provider}/${model.id}`}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isCurrent}
                            data-index={index}
                            onClick={() => void choose(model)}
                            onMouseMove={() => setActiveIndex(index)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                              index === activeIndex ? "bg-accent" : "",
                              isCurrent ? "text-primary" : "",
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate">{model.name}</span>
                            {model.reasoning ? <Badge>reasoning</Badge> : null}
                            {model.local ? <Badge>local</Badge> : null}
                            <span className="text-muted-foreground mono shrink-0 text-[10px]">
                              {formatContext(model.context_window)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>

          {swap ? (
            <p className="border-border text-muted-foreground border-t px-3 py-2 text-[11px] leading-relaxed">
              Changes which model answers next. Memories already retrieved here
              stay as they are.
            </p>
          ) : null}

          {Object.entries(data?.local_errors ?? {}).length > 0 ? (
            <div className="border-border text-muted-foreground border-t px-3 py-2 text-[11px]">
              {Object.entries(data?.local_errors ?? {}).map(([provider, message]) => (
                <p key={provider} className="truncate" title={message}>
                  {provider}: offline
                </p>
              ))}
            </div>
          ) : null}

          {error ? (
            <div className="border-border text-destructive border-t px-3 py-2 text-[11px]">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
