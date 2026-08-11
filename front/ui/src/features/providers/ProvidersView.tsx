import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearProviderKey, listModels, listProviders, setProviderKey } from "@/lib/seat/client";
import type { ProviderInfo, SeatReachability } from "@/lib/seat/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { McpServers } from "./McpServers";
import { OAuthFlow } from "./OAuthFlow";

/**
 * Sign in, stated precisely: provider credentials for the model endpoints the
 * seat can call. This is NOT an account system — shodh is local-first and has
 * no accounts. A key submitted here goes over the same-origin proxy to the
 * seat process, lands in its credential file, and never returns to any
 * browser; what this screen reads back is presence and pi's source label
 * ("ANTHROPIC_API_KEY", "stored key", "OAuth"), never material.
 *
 * Kept deliberately distinct from the profile control in the rail: the
 * profile chooses WHOSE MEMORY is on screen; this chooses WHICH MODELS can be
 * reached. Different questions, different lifetimes.
 */

function StatusDot({ configured }: { configured: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        configured ? "bg-[var(--live)]" : "bg-muted-foreground/40",
      )}
    />
  );
}

function ProviderRow({ provider }: { provider: ProviderInfo }) {
  const queryClient = useQueryClient();
  // Three auth shapes, three actions: an API-key form, a browser OAuth
  // flow, or nothing at all for keyless local endpoints. Never one field.
  const [mode, setMode] = useState<"idle" | "key" | "oauth">("idle");
  const editing = mode === "key";
  const setEditing = (open: boolean) => setMode(open ? "key" : "idle");
  const [draft, setDraft] = useState("");

  const patchCache = (updated: ProviderInfo) => {
    queryClient.setQueryData<{ providers: ProviderInfo[] }>(["seat-providers"], (old) =>
      old
        ? { providers: old.providers.map((p) => (p.id === updated.id ? updated : p)) }
        : old,
    );
    // Configured providers gate the model catalog.
    void queryClient.invalidateQueries({ queryKey: ["seat-models"] });
  };

  const save = useMutation({
    mutationFn: (key: string) => setProviderKey(provider.id, key),
    onSuccess: (updated) => {
      patchCache(updated);
      setEditing(false);
      setDraft("");
    },
  });
  const remove = useMutation({
    mutationFn: () => clearProviderKey(provider.id),
    onSuccess: patchCache,
  });

  return (
    <div className="border-border border-b px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <StatusDot configured={provider.configured} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{provider.name}</span>
        {provider.local ? <Badge className="mono">local</Badge> : null}
        <span className="text-muted-foreground mono hidden shrink-0 text-[10px] sm:inline">
          {provider.model_count} model{provider.model_count === 1 ? "" : "s"}
        </span>
        <span
          className="text-muted-foreground mono max-w-[180px] shrink-0 truncate text-[10px]"
          title={provider.source ?? undefined}
        >
          {provider.configured ? (provider.stored ? "stored key" : (provider.source ?? "configured")) : "not configured"}
        </span>
        {provider.oauth_available ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode(mode === "oauth" ? "idle" : "oauth")}
            aria-expanded={mode === "oauth"}
            aria-label={`Sign in to ${provider.name}${provider.oauth_label ? ` (${provider.oauth_label})` : ""}`}
            title={
              provider.oauth_subscription
                ? `Flat-rate plan sign-in${provider.oauth_label ? `: ${provider.oauth_label}` : ""}`
                : undefined
            }
          >
            Sign in{provider.oauth_subscription ? " · plan" : ""}
          </Button>
        ) : null}
        {provider.accepts_api_key ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(!editing)}
            aria-expanded={editing}
            aria-label={`${provider.stored ? "Replace" : "Set"} API key for ${provider.name}`}
          >
            <KeyRound />
            {provider.stored ? "Replace key" : "Set key"}
          </Button>
        ) : null}
        {provider.stored ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Remove stored key for ${provider.name}`}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="mt-2 flex items-center gap-2 pl-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) save.mutate(draft.trim());
          }}
        >
          <Input
            type="password"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`${provider.name} API key`}
            aria-label={`${provider.name} API key`}
            autoComplete="off"
            className="max-w-[360px]"
          />
          <Button type="submit" size="sm" disabled={!draft.trim() || save.isPending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {save.isError ? (
        <p className="text-destructive mt-1 pl-4 text-[11px]">
          {save.error instanceof Error ? save.error.message : "Could not store the key."}
        </p>
      ) : null}

      {mode === "oauth" ? (
        <OAuthFlow
          provider={provider}
          onDone={(updated) => {
            if (updated) patchCache(updated);
            setMode("idle");
          }}
        />
      ) : null}
    </div>
  );
}

export function ProvidersView({ seat }: { seat: SeatReachability }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [showUnconfigured, setShowUnconfigured] = useState(false);

  const providersQuery = useQuery({
    queryKey: ["seat-providers"],
    queryFn: ({ signal }) => listProviders(signal),
    enabled: seat.state === "online",
    staleTime: 30_000,
  });

  const refreshLocal = useMutation({
    mutationFn: () => listModels(true),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["seat-providers"] });
      void queryClient.invalidateQueries({ queryKey: ["seat-models"] });
    },
  });

  const providers = providersQuery.data?.providers ?? [];
  const needle = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      providers.filter(
        (provider) =>
          !needle ||
          provider.name.toLowerCase().includes(needle) ||
          provider.id.toLowerCase().includes(needle),
      ),
    [providers, needle],
  );
  const configured = matches.filter((provider) => provider.configured);
  const unconfigured = matches.filter((provider) => !provider.configured);
  const localErrors = refreshLocal.data?.local_errors ?? {};

  if (seat.state !== "online") {
    return (
      <EmptyState
        size="page"
        title="Seat not running"
        body="Provider access is managed by the seat harness, a local process that holds every credential server-side. Start it (seat/README.md) and this screen picks up on its own."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 justify-center overflow-hidden">
      <div className="flex h-full min-h-0 w-full max-w-[720px] flex-col">
        <header className="shrink-0 px-4 pt-5 pb-3">
          <h2 className="text-[15px] font-medium tracking-tight">Provider access</h2>
          <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
            Which model endpoints the seat can call. Keys are held by the local
            seat process — set here, stored in its credential file, never sent
            to a browser. Environment variables keep working; a key stored here
            takes precedence for that provider.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter providers…"
              aria-label="Filter providers"
              className="max-w-[240px]"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={refreshLocal.isPending}
              onClick={() => refreshLocal.mutate()}
              aria-label="Re-probe local endpoints (Ollama, LM Studio)"
            >
              <RefreshCw className={cn(refreshLocal.isPending && "animate-spin")} />
              Probe local endpoints
            </Button>
          </div>
          {Object.entries(localErrors).map(([id, message]) => (
            <p key={id} className="text-warn mt-1.5 text-[11px]" title={message}>
              {id}: not reachable — start it and probe again.
            </p>
          ))}
        </header>

        <ScrollArea className="min-h-0 flex-1">
          {providersQuery.isPending ? (
            <p className="text-muted-foreground px-4 py-6 text-[12px]">Listing providers…</p>
          ) : (
            <>
              <div className="text-muted-foreground/70 border-border border-b px-4 pb-1 text-[10px] tracking-wide uppercase">
                Ready ({configured.length})
              </div>
              {configured.length === 0 ? (
                <p className="text-muted-foreground border-border border-b px-4 py-3 text-[12px] leading-relaxed">
                  No provider is configured yet. Set an API key below, export
                  the provider's environment variable before starting the seat,
                  or start Ollama / LM Studio for keyless local models.
                </p>
              ) : (
                configured.map((provider) => <ProviderRow key={provider.id} provider={provider} />)
              )}

              <button
                type="button"
                onClick={() => setShowUnconfigured((v) => !v)}
                aria-expanded={showUnconfigured}
                className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring w-full px-4 pt-4 pb-1 text-left text-[10px] tracking-wide uppercase focus-visible:ring-2 focus-visible:outline-none"
              >
                {showUnconfigured ? "▾" : "▸"} Available ({unconfigured.length})
              </button>
              {showUnconfigured
                ? unconfigured.map((provider) => <ProviderRow key={provider.id} provider={provider} />)
                : null}
            </>
          )}
          {/* The other half of "what can my agent reach": model endpoints
              above, the tool servers it can act through below. One question,
              so one screen. */}
          <McpServers />
        </ScrollArea>
      </div>
    </div>
  );
}
