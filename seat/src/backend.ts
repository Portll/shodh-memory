/**
 * Typed HTTP client for the shodh-memory Rust backend.
 *
 * Every shape below is transcribed from the actual handler source
 * (src/handlers/types.rs, src/handlers/recall.rs, src/handlers/remember.rs,
 * src/handlers/crud.rs, src/memory/types.rs) — field names match the serde
 * serialization exactly. Do not "fix" casing here without re-reading the Rust.
 */

/** src/memory/types.rs `ScoreAttribution` — present per memory when recall is called with debug:true. */
export interface ScoreAttribution {
	memory_id: string;
	rrf_base: number;
	graph_rrf: number;
	hybrid_rrf: number;
	hebbian_boost: number;
	attribute_boost: number;
	temporal_prefilter_boost: number;
	temporal_fact_boost: number;
	interference_adjustment: number;
	prospective_boost: number;
	fact_source_boost: number;
	ontological_boost: number;
	importance_factor: number;
	recency_factor: number;
	arousal_factor: number;
	credibility_factor: number;
	feedback_multiplier: number;
	quality_gate: number;
	final_score: number;
	sources: string[];
}

/** src/handlers/types.rs `RecallExperience` */
export interface RecallExperience {
	content: string;
	memory_type: string | null;
	tags: string[];
}

/** src/handlers/types.rs `RecallMemory` */
export interface RecallMemory {
	id: string;
	experience: RecallExperience;
	importance: number;
	created_at: string;
	score: number;
	tier: string;
	score_attribution?: ScoreAttribution;
}

/** src/handlers/types.rs `RecallFact` */
export interface RecallFact {
	id: string;
	fact: string;
	confidence: number;
	support_count: number;
	related_entities: string[];
}

/** src/handlers/types.rs `RecallTodo` */
export interface RecallTodo {
	id: string;
	short_id: string;
	content: string;
	status: string;
	priority: string;
	project: string | null;
	due_date: string | null;
	score: number;
}

/** src/handlers/types.rs `RecallLineageEdge` */
export interface RecallLineageEdge {
	from: string;
	to: string;
	relation: string;
	confidence: number;
}

/** src/handlers/types.rs `RecallReminder` */
export interface RecallReminder {
	id: string;
	content: string;
	keywords: string[];
	match_type: string;
	priority: number;
	created_at: string;
}

/** src/handlers/types.rs `RecallResponse` (vectors are skip_serializing_if empty → optional here). */
export interface RecallResponse {
	memories: RecallMemory[];
	count: number;
	retrieval_stats?: unknown;
	todos?: RecallTodo[];
	todo_count?: number;
	facts?: RecallFact[];
	fact_count?: number;
	triggered_reminders?: RecallReminder[];
	reminder_count?: number;
	lineage?: RecallLineageEdge[];
	lineage_count?: number;
}

/** Valid `mode` values, from src/handlers/recall.rs `parse_retrieval_mode`. */
export type RecallMode =
	| "hybrid"
	| "semantic"
	| "associative"
	| "temporal"
	| "causal"
	| "spatial"
	| "mission"
	| "action_outcome";

/** Valid memory types, from src/handlers/remember.rs `parse_experience_type`. */
export type MemoryType =
	| "observation"
	| "decision"
	| "learning"
	| "error"
	| "discovery"
	| "pattern"
	| "context"
	| "task"
	| "code_edit"
	| "file_access"
	| "search"
	| "command"
	| "conversation"
	| "intention";

/** src/handlers/recall.rs `reinforce_feedback` outcome strings. */
export type ReinforceOutcome = "helpful" | "misleading" | "neutral";

/** src/handlers/recall.rs `ReinforceFeedbackResponse` */
export interface ReinforceStats {
	memories_processed: number;
	associations_strengthened: number;
	importance_boosts: number;
	importance_decays: number;
}

/** src/handlers/remember.rs `RememberResponse` */
export interface RememberResponse {
	id: string;
	success: boolean;
}

/** src/memory/feedback.rs `ToolAction` — tool-aware feedback attribution input. */
export interface ToolAction {
	tool_name: string;
	inputs: Record<string, string>;
	success: boolean;
	output_snippet?: string;
}

/** src/handlers/recall.rs `ProactiveSurfacedMemory` (embedding is #[serde(skip)] — never sent). */
export interface ProactiveSurfacedMemory {
	id: string;
	content: string;
	memory_type: string;
	score: number;
	importance: number;
	created_at: string;
	tags: string[];
	tier: string;
	relevance_reason: string;
	matched_entities?: string[];
}

/** src/handlers/recall.rs `FeedbackProcessed` */
export interface FeedbackProcessed {
	memories_evaluated: number;
	reinforced: string[];
	weakened: string[];
}

/** src/handlers/recall.rs `ProactiveContextResponse` (fields the seat consumes; extras tolerated). */
export interface ProactiveContextResponse {
	memories: ProactiveSurfacedMemory[];
	memory_count: number;
	feedback_processed?: FeedbackProcessed;
	temporal_credits_applied?: number;
	latency_ms: number;
	ingested_memory_id?: string;
}

export class ShodhBackendError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(message: string, status: number, body: string) {
		super(message);
		this.name = "ShodhBackendError";
		this.status = status;
		this.body = body;
	}
}

export interface RecallParams {
	userId: string;
	query: string;
	limit?: number;
	mode?: RecallMode;
	/** debug:true asks the pipeline for per-memory ScoreAttribution. */
	debug?: boolean;
}

export interface RememberParams {
	userId: string;
	content: string;
	memoryType?: MemoryType;
	tags?: string[];
	importance?: number;
}

export interface ProactiveContextParams {
	userId: string;
	context: string;
	maxResults?: number;
	semanticThreshold?: number;
	/**
	 * Required, no default: the backend defaults auto_ingest to TRUE
	 * (src/handlers/recall.rs:172-174) and silently ingests the previous
	 * response as memories. Callers must decide explicitly.
	 */
	autoIngest: boolean;
	/** Previous assistant message — triggers implicit-feedback processing of the pending surfaced set. */
	previousResponse?: string;
	/** The user message following that response (negative-keyword detection). */
	userFollowup?: string;
	/** Tool actions performed since the pending set was surfaced (tool-aware attribution). */
	toolActions?: ToolAction[];
}

export class ShodhBackend {
	private readonly apiUrl: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;

	constructor(apiUrl: string, apiKey: string, timeoutMs: number) {
		this.apiUrl = apiUrl;
		this.apiKey = apiKey;
		this.timeoutMs = timeoutMs;
	}

	private async request<T>(method: "GET" | "POST" | "DELETE", pathname: string, body?: unknown): Promise<T> {
		const url = `${this.apiUrl}${pathname}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: {
					"Content-Type": "application/json",
					"X-API-Key": this.apiKey,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new ShodhBackendError(`Backend unreachable (${method} ${pathname}): ${reason}`, 0, "");
		}
		const text = await response.text();
		if (!response.ok) {
			throw new ShodhBackendError(
				`Backend error ${response.status} on ${method} ${pathname}`,
				response.status,
				text.slice(0, 2000),
			);
		}
		return JSON.parse(text) as T;
	}

	/** POST /api/recall — src/handlers/recall.rs `recall`, request shape src/handlers/types.rs `RecallRequest`. */
	recall(params: RecallParams): Promise<RecallResponse> {
		return this.request<RecallResponse>("POST", "/api/recall", {
			user_id: params.userId,
			query: params.query,
			limit: params.limit ?? 5,
			mode: params.mode ?? "hybrid",
			debug: params.debug ?? false,
		});
	}

	/** POST /api/remember — src/handlers/remember.rs `remember` / `RememberRequest`. */
	remember(params: RememberParams): Promise<RememberResponse> {
		return this.request<RememberResponse>("POST", "/api/remember", {
			user_id: params.userId,
			content: params.content,
			memory_type: params.memoryType,
			tags: params.tags ?? [],
			importance: params.importance,
		});
	}

	/**
	 * POST /api/proactive_context — src/handlers/recall.rs `proactive_context`.
	 *
	 * This is the ONLY handler that writes feedback momentum (the
	 * `feedback_multiplier` in ScoreAttribution): when `previous_response` is
	 * present it consumes the pending surfaced set from the PREVIOUS call,
	 * computes implicit-feedback signals, updates momentum, and internally
	 * applies reinforce_recall + Hebbian edge strengthening for helpful and
	 * misleading classifications (recall.rs:1670-1720). It then surfaces a new
	 * set and stores it as pending for the next call.
	 */
	proactiveContext(params: ProactiveContextParams): Promise<ProactiveContextResponse> {
		return this.request<ProactiveContextResponse>("POST", "/api/proactive_context", {
			user_id: params.userId,
			context: params.context,
			max_results: params.maxResults ?? 5,
			semantic_threshold: params.semanticThreshold ?? 0.6,
			auto_ingest: params.autoIngest,
			previous_response: params.previousResponse,
			user_followup: params.userFollowup,
			...(params.toolActions && params.toolActions.length > 0 ? { tool_actions: params.toolActions } : {}),
		});
	}

	/** POST /api/reinforce — src/handlers/recall.rs `reinforce_feedback` / `ReinforceFeedbackRequest`. */
	reinforce(userId: string, ids: string[], outcome: ReinforceOutcome): Promise<ReinforceStats> {
		return this.request<ReinforceStats>("POST", "/api/reinforce", {
			user_id: userId,
			ids,
			outcome,
		});
	}

	/** DELETE /api/memory/{id}?user_id=… — src/handlers/crud.rs `delete_memory`. */
	deleteMemory(userId: string, memoryId: string): Promise<unknown> {
		return this.request<unknown>(
			"DELETE",
			`/api/memory/${encodeURIComponent(memoryId)}?user_id=${encodeURIComponent(userId)}`,
		);
	}

	/** GET /health — src/handlers/health.rs `health`. */
	health(): Promise<{ status: string; version: string }> {
		return this.request<{ status: string; version: string }>("GET", "/health");
	}
}
