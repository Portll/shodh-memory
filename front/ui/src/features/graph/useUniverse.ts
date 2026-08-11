import { useQuery } from "@tanstack/react-query";
import { fetchUniverse } from "@/lib/api/graph";
import { buildUniverse, type UniverseModel } from "./universe";
import type { Reachability } from "@/lib/api";
import { useSession } from "@/stores/session";

/**
 * The entity knowledge graph, fetched once per profile and cached BUILT.
 *
 * The query function does the clustering as well as the fetch, so what lands in
 * the cache is the finished `UniverseModel` rather than the raw payload. Two
 * reasons, both load-bearing:
 *
 *  - Louvain over the full edge set is the expensive part, not the request.
 *    Caching the raw payload would re-run it on every mount and on every
 *    consumer, which is exactly the "hung the tab" failure the old dashboard
 *    documented.
 *  - The Inspector reads this same cache entry to resolve a selected entity and
 *    its typed edges. It needs the adjacency, not the wire payload, and it must
 *    not build its own — two models of one graph would drift.
 *
 * `staleTime: Infinity` because the universe is a corpus-level structure: it
 * does not change while someone is reading it, and a background refetch would
 * silently re-cluster and move every node under the pointer. It is refetched by
 * changing profile, which is a different corpus and a different key.
 */

export function universeKey(profile: string | null) {
  return ["graph-universe", profile] as const;
}

export interface UniverseQuery {
  model: UniverseModel | undefined;
  error: unknown;
  isFetching: boolean;
  enabled: boolean;
  profile: string | null;
}

export function useUniverse(reach: Reachability): UniverseQuery {
  const profile = useSession((s) => s.profile);
  const enabled = reach.state === "online" && profile !== null;

  const { data, error, isFetching } = useQuery({
    queryKey: universeKey(profile),
    queryFn: async ({ signal }) => buildUniverse(await fetchUniverse(profile!, signal)),
    enabled,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });

  return { model: data, error, isFetching, enabled, profile };
}
