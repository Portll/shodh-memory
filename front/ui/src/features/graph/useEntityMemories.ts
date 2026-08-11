import { useQuery } from "@tanstack/react-query";
import { traverseEntity, fetchEpisode, type EpisodicNode } from "@/lib/api/graph";

/**
 * Entity → the memories it was extracted from.
 *
 * Two chained calls, because no single endpoint does this (see the long note in
 * lib/api/graph.ts):
 *
 *  1. `POST /api/graph/traverse` at depth 1 for the entity's name, then keep
 *     only the edges that actually touch this entity — traverse returns the
 *     whole subgraph, including edges between the entity's neighbours.
 *  2. Collect every `source_episode_id` off those edges and their provenance
 *     records. Each is a memory id, because an episode's uuid IS the memory id
 *     (src/handlers/state.rs:3349-3350).
 *  3. Hydrate a bounded number of them through `POST /api/graph/episode/get`.
 *
 * The hydration is capped. Each id is its own request, and an entity in a dense
 * corpus can attest hundreds of edges; firing all of them to fill a panel that
 * shows a handful would be a burst of traffic nobody asked for. The cap is
 * stated in the UI alongside the true count.
 */

const HYDRATE_LIMIT = 8;

export interface EntityMemories {
  episodes: EpisodicNode[];
  /** Distinct source memory ids found, before the hydration cap. */
  totalSources: number;
}

export function entityMemoriesKey(profile: string | null, entityName: string | null) {
  return ["entity-memories", profile, entityName] as const;
}

export function useEntityMemories(profile: string | null, entityName: string | null, entityId: string | null) {
  return useQuery<EntityMemories>({
    queryKey: entityMemoriesKey(profile, entityName),
    enabled: profile !== null && entityName !== null && entityId !== null,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const traversal = await traverseEntity(
        { user_id: profile!, entity_name: entityName!, max_depth: 1 },
        signal,
      );

      const ids: string[] = [];
      const seen = new Set<string>();
      const add = (id: string | null | undefined) => {
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
      };

      for (const edge of traversal.relationships ?? []) {
        // Traverse returns the whole traversed subgraph; only edges incident to
        // THIS entity are evidence about it.
        if (edge.from_entity !== entityId && edge.to_entity !== entityId) continue;
        add(edge.source_episode_id);
        for (const p of edge.provenance ?? []) add(p.source_episode_id);
      }

      const hydrated = await Promise.all(
        ids.slice(0, HYDRATE_LIMIT).map((id) =>
          // One unknown episode must not empty the panel.
          fetchEpisode(profile!, id, signal).catch(() => null),
        ),
      );

      return {
        episodes: hydrated.filter((e): e is EpisodicNode => e !== null && !!e.content),
        totalSources: ids.length,
      };
    },
  });
}
