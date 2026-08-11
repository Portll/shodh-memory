import { useQuery } from "@tanstack/react-query";
import { recall, type Reachability, type RecallResponse } from "@/lib/api";
import { useSession } from "@/stores/session";

/**
 * The one recall query.
 *
 * Three surfaces now render the same result set — the result list, the graph
 * canvas and the geo map — and recall is expensive: it runs a multi-leg
 * retrieval (vector + BM25 + graph), then fusion and re-ranking. Each surface
 * calling `useQuery` with its own inline key would risk a typo splitting them
 * into separate cache entries and paying that cost two or three times over for
 * one search.
 *
 * Declaring the key once removes the possibility. Every caller of this hook
 * shares a single cache entry and a single in-flight request, so "the current
 * recall result set" is literally the same object everywhere rather than three
 * copies that agree most of the time. The Inspector reads the same key out of
 * the cache directly (Inspector.tsx:58) — `RECALL_KEY` is exported so that read
 * cannot drift from these writes either.
 */

export function recallKey(profile: string | null, query: string) {
  return ["recall", profile, query] as const;
}

export interface RecallQuery {
  data: RecallResponse | undefined;
  error: unknown;
  isFetching: boolean;
  /** False when there is nothing to ask — offline, no profile, or empty cue. */
  enabled: boolean;
  profile: string | null;
  query: string;
}

export function useRecall(reach: Reachability): RecallQuery {
  const profile = useSession((s) => s.profile);
  const query = useSession((s) => s.activeQuery);

  const enabled = reach.state === "online" && profile !== null && query.trim().length > 0;

  const { data, error, isFetching } = useQuery({
    // The profile is part of the key, not just the payload: switching profile
    // is switching corpus, and showing the previous one's hits under a new
    // profile would be a correctness bug, not a stale-cache annoyance.
    queryKey: recallKey(profile, query),
    queryFn: ({ signal }) => recall({ user_id: profile!, query }, signal),
    enabled,
  });

  return { data, error, isFetching, enabled, profile, query };
}
