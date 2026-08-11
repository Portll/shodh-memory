import { api } from "./client";
import type { RecallRequest, RecallResponse } from "./types";

/**
 * POST /api/recall — src/handlers/router.rs:106.
 *
 * `debug: true` is sent unconditionally. It is what populates
 * `score_attribution`, and there is no way to fetch that for a single memory
 * afterwards — it is all-or-nothing per query. Since the whole point of the
 * Inspector is answering "why did this surface", asking for it later is not an
 * option, and asking twice would double the retrieval cost.
 */
export function recall(req: RecallRequest, signal?: AbortSignal): Promise<RecallResponse> {
  return api.post<RecallResponse>(
    "/api/recall",
    { limit: 25, mode: "hybrid", debug: true, ...req },
    signal,
  );
}
