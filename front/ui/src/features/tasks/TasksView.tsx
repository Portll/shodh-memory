import { useQuery } from "@tanstack/react-query";
import {
  Circle,
  CircleDashed,
  CircleDot,
  CircleSlash,
  type LucideIcon,
} from "lucide-react";
import { listTodos, ApiError, NetworkError, type Reachability, type Todo, type TodoStatus } from "@/lib/api";
import { useSession } from "@/stores/session";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * Tasks — GTD todos captured from sessions, against the real
 * `POST /api/todos` (src/handlers/todos.rs:1160).
 *
 * WORKFLOWS.md's Chain 4 reads "Tasks → task → the session that captured it
 * → Chain 2", handing off into the Inspector like every other list. That
 * hand-off is not built here, deliberately: `Todo` (src/memory/types.rs:3646)
 * carries no session reference — only `related_memory_ids`, a link to
 * memories, not to the session that created them — and the Inspector reads
 * its data out of the `["recall", profile, query]` react-query cache, which
 * a todo was never part of. Wiring a `select()` call here would open the
 * Inspector on a stale or absent cache entry. This is one list that does not
 * feed the one Inspector; it is a real, standalone list against real data
 * instead of a half-wired chain.
 *
 * Server default: `include_completed` is false (todos.rs:1224), so `done`
 * and `cancelled` never come back — nothing to group them under here.
 */

const STATUS_ORDER: TodoStatus[] = ["in_progress", "blocked", "todo", "backlog"];

const STATUS_META: Record<TodoStatus, { label: string; icon: LucideIcon; iconClass: string }> = {
  in_progress: { label: "In progress", icon: CircleDot, iconClass: "text-foreground" },
  // Blocked is the one status that is itself "worth a look" rather than
  // ordinary workflow state — `--warn`, not the chrome accent.
  blocked: { label: "Blocked", icon: CircleSlash, iconClass: "text-warn" },
  todo: { label: "Todo", icon: Circle, iconClass: "text-muted-foreground" },
  backlog: { label: "Backlog", icon: CircleDashed, iconClass: "text-muted-foreground/60" },
  done: { label: "Done", icon: Circle, iconClass: "text-muted-foreground" },
  cancelled: { label: "Cancelled", icon: Circle, iconClass: "text-muted-foreground" },
};

/** Mirrors `Todo::short_id()` (src/memory/types.rs:3776-3784) exactly,
 *  including its "SHO" fallback prefix and its first-4-hex-chars fallback
 *  for legacy todos with no `seq_num` — neither is invented here. */
function shortId(t: Todo): string {
  if (t.seq_num > 0) return `${t.project_prefix ?? "SHO"}-${t.seq_num}`;
  return `SHO-${t.id.slice(0, 4)}`;
}

/** `Todo::is_overdue()` (src/memory/types.rs:3787-3795), re-derived: the
 *  server does not send a boolean, only `due_date`. */
function dueMeta(t: Todo): { label: string; tone: "destructive" | "warn" | "muted" } | null {
  if (!t.due_date) return null;
  const due = new Date(t.due_date);
  if (Number.isNaN(due.getTime())) return null;
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: `Overdue ${Math.abs(days)}d`, tone: "destructive" };
  if (days === 0) return { label: "Due today", tone: "warn" };
  if (days <= 3) return { label: `Due in ${days}d`, tone: "warn" };
  return { label: `Due ${due.toLocaleDateString()}`, tone: "muted" };
}

function TaskRow({ todo }: { todo: Todo }) {
  const meta = STATUS_META[todo.status];
  const Icon = meta.icon;
  const due = dueMeta(todo);

  return (
    <div className="border-border flex items-start gap-3 border-b px-4 py-3">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", meta.iconClass)} strokeWidth={1.8} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-[13px] leading-relaxed">{todo.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground/70 mono text-[10px]">{shortId(todo)}</span>
          {todo.project_prefix ? <Badge>{todo.project_prefix}</Badge> : null}
          {todo.priority === "urgent" ? <Badge variant="destructive">Urgent</Badge> : null}
          {todo.priority === "high" ? <Badge variant="warn">High</Badge> : null}
          {due ? (
            due.tone === "muted" ? (
              <span className="text-muted-foreground mono text-[10px]">{due.label}</span>
            ) : (
              <Badge variant={due.tone} className="mono">
                {due.label}
              </Badge>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusGroup({ status, todos }: { status: TodoStatus; todos: Todo[] }) {
  if (todos.length === 0) return null;
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <section>
      <div className="border-border bg-muted/50 sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-1.5 backdrop-blur-sm">
        <Icon aria-hidden="true" className={cn("size-3", meta.iconClass)} strokeWidth={1.8} />
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {meta.label}
        </span>
        <span className="text-muted-foreground/60 mono text-[10px]">{todos.length}</span>
      </div>
      {todos.map((t) => (
        <TaskRow key={t.id} todo={t} />
      ))}
    </section>
  );
}

function TaskRowSkeleton() {
  return (
    <div className="border-border flex items-start gap-3 border-b px-4 py-3">
      <Skeleton className="mt-0.5 size-3.5 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <Skeleton className="h-[13px] w-[75%]" />
        <div className="mt-1.5 flex items-center gap-1.5">
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5 w-10" />
        </div>
      </div>
    </div>
  );
}

export function TasksView({ reach }: { reach: Reachability }) {
  const profile = useSession((s) => s.profile);
  const enabled = reach.state === "online" && profile !== null;

  const { data, error, isFetching } = useQuery({
    queryKey: ["todos", profile],
    queryFn: ({ signal }) => listTodos({ user_id: profile!, limit: 200 }, signal),
    enabled,
  });

  if (reach.state !== "online") {
    return (
      <EmptyState
        size="page"
        title="Not connected"
        body="Open work appears here once the memory server is running."
      />
    );
  }

  if (profile === null) {
    return (
      <EmptyState
        size="page"
        title="No profile to browse"
        body="This instance holds no memory yet."
      />
    );
  }

  if (error) {
    const detail =
      error instanceof ApiError
        ? error.isAuthFailure
          ? "The server rejected this key."
          : `The server answered ${error.status}.`
        : error instanceof NetworkError
          ? "The server stopped responding mid-request."
          : "Something went wrong loading tasks.";
    return <EmptyState size="page" title="Could not load tasks" body={detail} />;
  }

  if (isFetching && !data) {
    return (
      <div className="mx-auto h-full w-full max-w-2xl">
        {Array.from({ length: 6 }, (_, i) => (
          <TaskRowSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (data && data.todos.length === 0) {
    return (
      <EmptyState
        size="page"
        title="Nothing outstanding"
        body="No open todos in this profile."
        more="Tasks are picked up from what was recorded in a session — yours or an agent's — rather than entered here, so they appear as work is captured."
      />
    );
  }

  return data ? (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-2xl">
        {STATUS_ORDER.map((status) => (
          <StatusGroup
            key={status}
            status={status}
            todos={data.todos.filter((t) => t.status === status)}
          />
        ))}
      </div>
    </ScrollArea>
  ) : null;
}
