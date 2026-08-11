import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { listMcpServers, reconnectMcpServer } from "@/lib/seat/client";
import type { McpServerInfo } from "@/lib/seat/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { Meta, Stat } from "@/components/ui/meta";

/**
 * The tool servers the seat is connected to, on the same screen as the model
 * endpoints it can call.
 *
 * WHY IT LIVES HERE. Both halves of this screen answer one question — what can
 * my agent reach? — and they were only ever separable to an implementer.
 * Providers decide which models can think; these decide which tools they can
 * act with. Splitting them into two destinations would make a person check two
 * places to answer one question, so this is a section, not a route.
 *
 * WHAT IT REFUSES TO IMPLY. A tool listed here has been NAMED by its server,
 * not called by anything. The seat lists tools at connect time and again
 * whenever a server announces its list changed; it has no idea whether any of
 * them work. That caveat is visible copy rather than something inside the info
 * panel, because most people never open info panels and this one changes how
 * the numbers on screen should be read.
 */

/** Failure states are not interchangeable and the colour says which is which.
 *  A server that dropped was working a moment ago and usually comes back on a
 *  reconnect — that is the amber "look at this", not the red "this is broken".
 *  A server that never came up needs its configuration fixed first. */
function StatusDot({ status }: { status: McpServerInfo["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "ready" && "bg-[var(--live)]",
        status === "connecting" && "bg-muted-foreground/40 animate-pulse",
        status === "disconnected" && "bg-warn",
        status === "failed" && "bg-destructive",
      )}
    />
  );
}

/** Where the server runs, in the words someone would use to describe it —
 *  never the transport enum on its own. "sse" earns its extra token because a
 *  server on the superseded transport is a thing worth knowing about when it
 *  eventually stops working. */
function whereItRuns(server: McpServerInfo): string {
  if (server.transport === "stdio") return "on this machine";
  return server.transport === "sse" ? "remote · older transport" : "remote";
}

function statusWord(server: McpServerInfo): string | null {
  switch (server.status) {
    case "ready":
      return null;
    case "connecting":
      return "connecting";
    case "disconnected":
      return "connection dropped";
    case "failed":
      return server.connected_at ? "reconnect failed" : "never connected";
  }
}

function ServerRow({ server }: { server: McpServerInfo }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const reconnect = useMutation({
    mutationFn: () => reconnectMcpServer(server.name),
    onSuccess: (updated) => {
      queryClient.setQueryData<{ servers: McpServerInfo[] }>(["seat-mcp-servers"], (old) =>
        old
          ? { servers: old.servers.map((s) => (s.name === updated.name ? updated : s)) }
          : old,
      );
    },
  });

  // A server that has never been up is being CONNECTED, not re-connected. Small
  // thing, but the wrong word here reads as "this used to work", which sends
  // someone looking for what changed instead of at their configuration.
  const actionLabel = server.connected_at ? "Reconnect" : "Connect";
  const status = statusWord(server);
  const address = server.endpoint ?? server.command;

  return (
    <div className="border-border border-b px-4 py-2.5">
      <div className="flex items-center gap-2.5">
        <StatusDot status={server.status} />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={server.tools.length === 0}
          className="focus-visible:ring-ring min-w-0 flex-1 truncate text-left text-[13px] focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default"
        >
          {server.tools.length > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/50 mr-1">
              {open ? "▾" : "▸"}
            </span>
          ) : null}
          {server.name}
        </button>
        <Badge className="mono shrink-0">{whereItRuns(server)}</Badge>
        <Meta className="shrink-0">
          {server.status === "ready" || server.tool_count > 0 ? (
            <Stat value={server.tool_count} label={server.tool_count === 1 ? "tool" : "tools"} />
          ) : null}
          {status ? (
            <span
              className={cn(
                server.status === "failed" && "text-destructive",
                server.status === "disconnected" && "text-warn",
              )}
            >
              {status}
            </span>
          ) : null}
        </Meta>
        <Button
          size="sm"
          variant="ghost"
          disabled={reconnect.isPending || server.status === "connecting"}
          onClick={() => reconnect.mutate()}
          aria-label={`${actionLabel} ${server.name}`}
        >
          <RefreshCw className={cn(reconnect.isPending && "animate-spin")} />
          {actionLabel}
        </Button>
      </div>

      {address ? (
        <p className="text-muted-foreground/70 mono mt-1 truncate pl-4 text-[10px]" title={address}>
          {address}
          {server.auth_header_names.length > 0
            ? ` · sends ${server.auth_header_names.join(", ")}`
            : null}
        </p>
      ) : null}

      {/* The seat's own words for what went wrong, verbatim. A stdio server's
          last output can run to a stack trace, so it scrolls rather than
          pushing every other server off the screen. It carries the same colour
          as the status word above it — a dropped server is amber in both
          places, because a reason box in alarm red beside an amber status
          reads as two different verdicts on one server. */}
      {server.error ? (
        <pre
          className={cn(
            "mono mt-1.5 ml-4 max-h-24 overflow-auto rounded border p-2 text-[11px] leading-relaxed whitespace-pre-wrap",
            server.status === "disconnected"
              ? "text-warn border-warn/30 bg-warn/5"
              : "text-destructive border-destructive/20 bg-destructive/5",
          )}
        >
          {server.error}
        </pre>
      ) : null}

      {reconnect.isError ? (
        <p className="text-destructive mt-1 pl-4 text-[11px]">
          {reconnect.error instanceof Error ? reconnect.error.message : "Could not reach the seat."}
        </p>
      ) : null}

      {open && server.tools.length > 0 ? (
        <ul className="mt-2 ml-4 space-y-1">
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex min-w-0 items-baseline gap-2">
              <span className="mono text-foreground/85 shrink-0 text-[11px]">{tool.name}</span>
              {tool.description ? (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]" title={tool.description}>
                  {tool.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function McpServers() {
  const query = useQuery({
    queryKey: ["seat-mcp-servers"],
    queryFn: ({ signal }) => listMcpServers(signal),
    staleTime: 10_000,
    // A server can go away without anyone touching this screen — the seat
    // notices immediately, and a poll this cheap (a local process, a few
    // hundred bytes) is what carries that to the page someone is already
    // looking at. There is no push channel for it and inventing one for a
    // status list would be a lot of machinery for a 15-second delay.
    refetchInterval: 15_000,
  });

  const servers = query.data?.servers ?? [];
  const connected = servers.filter((server) => server.status === "ready");
  const reachableTools = connected.reduce((total, server) => total + server.tool_count, 0);
  const down = servers.length - connected.length;

  return (
    <section aria-labelledby="mcp-servers-heading">
      <div className="border-border flex items-center gap-1.5 border-b px-4 pt-6 pb-1">
        <h3
          id="mcp-servers-heading"
          className="text-muted-foreground/70 text-[10px] tracking-wide uppercase"
        >
          Tool servers{query.data ? ` (${servers.length})` : ""}
        </h3>
        <InfoHint label="Tool servers">
          Programs and endpoints that publish tools your agent can call — files,
          issue trackers, this memory itself. The seat starts the local ones and
          dials the remote ones, then offers their tools to the model under
          names like <span className="mono">mcp__shodh-memory__recall</span>.
          <br />
          <br />
          Access tokens for a remote server stay in the seat process; this page
          only ever names the headers being sent, never their contents.
          <br />
          <br />
          Nothing reconnects itself. A server that dropped stays visible and
          stays down until you reconnect it here — a background retry loop
          would hide the failure and hammer a server that is genuinely broken.
        </InfoHint>
      </div>

      {/* Three states that look identical if you only ever read `data`, and
          two of them are statements about the user's configuration that would
          be FALSE: a request still in flight, and a request that failed. The
          latter is the worse one — it persists, and it tells someone their
          servers are not configured when in truth the seat could not be
          asked. Kept apart, in the idiom the provider list above already
          uses. */}
      {query.isPending ? (
        <p className="text-muted-foreground border-border border-b px-4 py-3 text-[12px]">
          Listing tool servers…
        </p>
      ) : query.isError ? (
        <p className="text-destructive border-border border-b px-4 py-3 text-[12px] leading-relaxed">
          Could not ask the seat which tool servers it has
          {query.error instanceof Error ? `: ${query.error.message}` : "."} This
          says nothing about the servers themselves — they may well be
          connected.
        </p>
      ) : servers.length === 0 ? (
        <p className="text-muted-foreground border-border border-b px-4 py-3 text-[12px] leading-relaxed">
          No tool servers are configured. The seat reads them from the JSON file
          named by <span className="mono">SEAT_MCP_SERVERS</span> — a command to
          run for a server on this machine, or a URL for one hosted elsewhere.
        </p>
      ) : (
        <>
          <div className="border-border border-b px-4 py-2">
            <Meta>
              <Stat value={connected.length} label={`of ${servers.length} connected`} />
              <Stat value={reachableTools} label="tools reachable" />
              {down > 0 ? <span className="text-warn">{down} unavailable</span> : null}
            </Meta>
            {/* On screen, not in the info panel: it changes how the tool counts
                above should be read, and info panels mostly go unopened. */}
            <p className="text-muted-foreground/70 mt-1 text-[11px] leading-relaxed">
              Tools are listed as each server describes them. The seat has not
              called them.
            </p>
          </div>
          {servers.map((server) => (
            <ServerRow key={server.name} server={server} />
          ))}
        </>
      )}
    </section>
  );
}
