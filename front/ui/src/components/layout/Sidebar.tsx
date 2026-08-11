import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Search,
  TriangleAlert,
  ListChecks,
  ChevronDown,
  MessageSquare,
  KeyRound,
  Globe,
  Share2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isHumanProfile, type Reachability } from "@/lib/api";
import { useSession } from "@/stores/session";
import shodhMark from "@/assets/shodh-mark.png";

/**
 * Primary navigation — an icon rail that expands on hover or focus.
 *
 * Names are what the thing is, not what the subsystem is called:
 *   Recall     — the search surface (was "Live")
 *   Anomalies  — deviations from this user's own baseline (was unqualified)
 *   Tasks      — the todo list (was "Work", which named nothing)
 *
 * The rail is Gridline's structure with two deliberate departures. Its icons
 * are sized for a far sparser screen than this one, so they are smaller here.
 * And Gridline leaves the rail icon-only, hanging labels off tooltips — seven
 * unlabelled glyphs is a memory game, and a tooltip only pays out after you
 * have already guessed which one to point at. Expanding the whole column
 * instead shows every label at once, which is the question a person actually
 * has ("which of these is the one I want?").
 *
 * Three things this has to get right, none of them optional — all three
 * verified in a browser, not assumed:
 *
 *  - It expands as an OVERLAY. The stage behind it holds a graph; reflowing a
 *    force layout because a pointer crossed the edge of the screen is
 *    disorienting, and it re-lays-out the very thing being pointed at.
 *  - Focus expands it exactly as hover does, and the labels are in the DOM at
 *    all times — clipped, never absent — so a screen reader is never handed a
 *    column of bare icons.
 *  - Leaving is delayed. Pointers travel diagonally toward content and clip
 *    the rail's corner on the way out; closing on the first mouseleave makes
 *    it flicker.
 *
 * Reduced motion is handled globally in index.css, which collapses every
 * transition to 0.01ms — this component needs no separate branch for it.
 */

/**
 * The destinations, and the one line each of them is.
 *
 * A caption is not a tooltip and not a tagline. It is what someone needs in
 * order to know what they are looking at the moment they arrive, so it says
 * what the DATA on that screen is, in the words a person would use. Four rules
 * it is held to, all of them learned from copy that failed them:
 *
 *  - No subsystem words. "corpus", "session store", "spreading activation" name
 *    parts of this program, not things a reader has.
 *  - True of the screen as it opens, not of the screen after work. Geo used to
 *    promise "the current results" and then opened onto the whole map, which
 *    reads as the wrong screen rather than as a fuller one.
 *  - It labels; it does not sell. No adjective that the screen cannot be
 *    checked against.
 *  - A NOUN PHRASE, NOT A SENTENCE, AND UNDER SIX WORDS. These were clauses —
 *    "Search this memory, and see what connects to what" — sitting permanently
 *    beside a one-word title in a 48px bar, on every screen, on every visit.
 *    The caption has to survive being read at a glance by someone who has read
 *    it forty times before, and a clause does not: it gets skipped, which makes
 *    it cost its space and pay nothing. Naming the data in three words is read
 *    every time.
 *
 * Deliberately NOT moved behind an info affordance, and this is the one place
 * in the density pass where that was the wrong tool. The documented failure
 * this caption was added to fix is people arriving somewhere and not knowing
 * what the data means — and by definition those people do not know there is
 * anything to ask about, so an icon pays out to nobody. It gets shorter; it
 * does not get hidden.
 *
 * Read in two places — the rail itself, and the header next to the title
 * (TopBar.tsx). Both read it from here so the app cannot describe one
 * destination two ways.
 */
export const DESTINATIONS = [
  {
    id: "chat",
    path: "/chat",
    label: "Conversations",
    icon: MessageSquare,
    caption: "A model that can read this memory",
  },
  {
    id: "recall",
    path: "/recall",
    label: "Recall",
    icon: Search,
    caption: "Search memory and its connections",
  },
  {
    id: "graph",
    path: "/graph",
    label: "Graph",
    icon: Share2,
    caption: "Entities, and how they relate",
  },
  {
    id: "geo",
    path: "/geo",
    label: "Geo",
    icon: Globe,
    caption: "Where memory happened",
  },
  {
    id: "anomalies",
    path: "/anomalies",
    label: "Anomalies",
    icon: TriangleAlert,
    caption: "What deviates from this profile's normal",
  },
  {
    id: "tasks",
    path: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    caption: "Open work found in memory",
  },
  {
    id: "providers",
    path: "/providers",
    label: "Providers",
    icon: KeyRound,
    caption: "Where models run, and their keys",
  },
] as const;

export type DestinationId = (typeof DESTINATIONS)[number]["id"];

const CLOSE_DELAY_MS = 180;

/**
 * Label text that is clipped rather than removed when the rail is collapsed.
 * Kept as one component so no caller can accidentally unmount a label and
 * leave an icon with no accessible name.
 */
function RailLabel({
  open,
  children,
  className,
}: {
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "truncate transition-opacity duration-150",
        open ? "opacity-100" : "opacity-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Which profile's memory is on screen.
 *
 * Every option here came from `GET /api/users`; none is typed or guessed. That
 * is a correctness requirement, not tidiness — `get_user_memory`
 * (src/handlers/state.rs) provisions a fresh RocksDB store for any id it has
 * not seen rather than rejecting it, so a free-text profile field would let
 * someone create empty profiles by mistyping.
 *
 * Rendered as a native <select> deliberately. It is one of the few controls
 * that must work before anything else does, and the platform's own is
 * keyboard-complete, screen-reader-correct and impossible to get wrong.
 */
function ProfileSwitcher({ reach, open }: { reach: Reachability; open: boolean }) {
  const profile = useSession((s) => s.profile);
  const setProfile = useSession((s) => s.setProfile);

  // The seat stores its own lessons under `<user>.seat-harness` — a real
  // backend profile, but machinery, not a person. Offering it here invites
  // exactly the mistake the switcher exists to prevent: a human reading (or
  // writing!) the harness's internal scope as if it were their memory.
  const humanProfiles = reach.state === "online"
    ? reach.profiles.filter(isHumanProfile)
    : [];

  if (reach.state !== "online" || humanProfiles.length === 0 || !profile) return null;

  const single = humanProfiles.length === 1;

  return (
    <div className="border-sidebar-border border-t px-2 py-2">
      <div className="flex h-8 items-center gap-3 px-[0.65rem]">
        <span className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full" />
        <RailLabel open={open} className="min-w-0 flex-1">
          {single ? (
            <span className="text-muted-foreground text-[11px]">{profile}</span>
          ) : (
            <span className="relative flex items-center gap-1">
              <select
                aria-label="Active profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent text-[11px] focus-visible:ring-2 focus-visible:outline-none"
              >
                {humanProfiles.map((p) => (
                  <option key={p} value={p} className="bg-popover text-popover-foreground">
                    {p}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />
            </span>
          )}
        </RailLabel>
      </div>
    </div>
  );
}

export function Sidebar({ reach }: { reach: Reachability }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }, []);

  const openRail = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const closeRail = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  return (
    <aside
      aria-label="Primary navigation"
      // React's onFocus bubbles, so one handler on the container covers every
      // control inside without wiring each one.
      onMouseEnter={openRail}
      onMouseLeave={closeRail}
      onFocus={openRail}
      // A blur that lands on another control inside the rail is not a leave.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeRail();
      }}
      // Escape closes it for keyboard users who expanded it by tabbing in and
      // want it out of the way without leaving the rail.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          cancelClose();
          setOpen(false);
        }
      }}
      className={cn(
        "border-sidebar-border bg-sidebar text-sidebar-foreground",
        "absolute inset-y-0 left-0 z-30 flex flex-col overflow-hidden border-r",
        "transition-[width] duration-200 ease-out",
        open ? "w-56 shadow-2xl shadow-black/40" : "w-14",
      )}
    >
      <div className="border-sidebar-border flex h-12 shrink-0 items-center gap-3 border-b px-[0.9rem]">
        <img
          src={shodhMark}
          alt=""
          aria-hidden="true"
          className="size-6 shrink-0 object-contain"
        />
        <RailLabel open={open} className="text-[13px] font-semibold tracking-tight">
          shodh
        </RailLabel>
      </div>

      <nav className="flex flex-col gap-1 p-2">
        {DESTINATIONS.map((d) => {
          const Icon = d.icon;
          return (
            <NavLink
              key={d.id}
              to={d.path}
              className={({ isActive }) =>
                cn(
                  "flex h-9 shrink-0 items-center gap-3 rounded-lg px-[0.65rem] text-left text-[13px]",
                  "transition-colors duration-100",
                  "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                  isActive
                    ? "bg-primary/10 text-primary hover:bg-primary/20"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
              }
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
              <RailLabel open={open} className="font-medium">
                {d.label}
              </RailLabel>
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-auto shrink-0">
        <ProfileSwitcher reach={reach} open={open} />
      </div>
    </aside>
  );
}
