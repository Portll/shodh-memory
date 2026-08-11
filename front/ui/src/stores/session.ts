import { create } from "zustand";

/**
 * The two pieces of state that are genuinely global.
 *
 * WORKFLOWS.md: "Selection is global state, not per-panel. One selected object
 * at a time." Every list in the product feeds one Inspector, so the selected id
 * cannot live inside whichever list produced it — the graph, the result list
 * and the lineage edges all set and read the same value.
 *
 * The active profile is global for a harder reason. Every recall carries a
 * `user_id`, and `MultiUserMemoryManager::get_user_memory` (src/handlers/state.rs)
 * *creates* a store on demand for an id it has not seen — it does not 404. So a
 * wrong or invented profile does not fail loudly; it silently provisions an
 * empty RocksDB directory and returns no results. The active profile is
 * therefore only ever set from the list the server itself returned, and is
 * `null` until one arrives.
 */
interface SessionState {
  /** A value the server listed in `GET /api/users` — or, exactly once removed
   *  from that guarantee, a profile someone deliberately named on the seat's
   *  new-conversation screen (which the backend provisions on first write). */
  profile: string | null;
  /** True when `profile` was set by a deliberate act (switcher, seat creation)
   *  rather than adopted from the server list. A pinned profile survives
   *  reconciliation while the server has not yet listed it — the seat creates
   *  the store on the first turn, and wiping the selection in that window
   *  would tear down the conversation that is about to populate it. */
  profilePinned: boolean;
  /** Id of the memory currently open in the Inspector. */
  selectedMemoryId: string | null;
  /**
   * Id of the ENTITY currently open in the Inspector — a `UniverseStar.id` from
   * the knowledge graph, which is a different kind of object from a memory and
   * cannot share the field.
   *
   * Two ids rather than one tagged union because the two are genuinely
   * different objects reached from different destinations, and every existing
   * caller of `select`/`selectedMemoryId` would otherwise have to learn about a
   * kind it never encounters. They are mutually exclusive: selecting either
   * clears the other, so the Inspector still shows exactly one thing and the
   * "one selected object at a time" rule in WORKFLOWS.md holds.
   */
  selectedEntityId: string | null;
  /** The query the results on screen came from, for the Inspector's header. */
  activeQuery: string;

  setProfile: (profile: string | null) => void;
  select: (memoryId: string | null) => void;
  selectEntity: (entityId: string | null) => void;
  setActiveQuery: (query: string) => void;
  /** Adopt the server's list: keep the current profile if it is still offered
   *  (or pinned, see above), otherwise fall back to the first. Prevents a
   *  stale auto-adopted selection surviving a backend restart that dropped it. */
  reconcileProfiles: (profiles: string[]) => void;
}

export const useSession = create<SessionState>((set) => ({
  profile: null,
  profilePinned: false,
  selectedMemoryId: null,
  selectedEntityId: null,
  activeQuery: "",

  setProfile: (profile) =>
    set({
      profile,
      profilePinned: profile !== null,
      selectedMemoryId: null,
      selectedEntityId: null,
    }),
  select: (selectedMemoryId) => set({ selectedMemoryId, selectedEntityId: null }),
  selectEntity: (selectedEntityId) => set({ selectedEntityId, selectedMemoryId: null }),
  // Committing a query starts a new answer, and the selected object belonged to
  // the previous one. Left standing, it stays open in the Inspector beside a
  // result set it is not part of — verified in the browser: search from the
  // pre-query corpus listing with a row selected and the detail pane holds a
  // memory that appears nowhere in the results, which reads as a stale panel
  // rather than as a deliberate carry-over. Clearing both is the same rule
  // `setProfile` and `reconcileProfiles` already follow for the same reason.
  setActiveQuery: (activeQuery) =>
    set({ activeQuery, selectedMemoryId: null, selectedEntityId: null }),

  reconcileProfiles: (profiles) =>
    set((s) => {
      if (s.profile && (profiles.includes(s.profile) || s.profilePinned)) return s;
      // Both selections clear on a profile change: they name objects in the
      // previous profile's corpus, and an id from one store means nothing in
      // another.
      if (profiles.length === 0) {
        return s.profile === null
          ? s
          : { profile: null, selectedMemoryId: null, selectedEntityId: null };
      }
      return {
        profile: profiles[0],
        profilePinned: false,
        selectedMemoryId: null,
        selectedEntityId: null,
      };
    }),
}));
