/**
 * Client-side mirror of the backend's implicit-feedback heuristics.
 *
 * The backend owns the learning mechanics (EMA momentum, inertia, Hebbian
 * strengthening — src/memory/feedback.rs, applied through POST /api/reinforce).
 * The harness only needs to decide WHICH surfaced memories a response actually
 * used, and it deliberately reuses the backend's own published semantics
 * rather than inventing parallel ones:
 *
 * - Token extraction mirrors feedback.rs `extract_entities_simple`
 *   (lowercase, split on non-alphanumeric except '_', keep length > 2).
 * - Usage overlap mirrors `calculate_entity_overlap`
 *   (|memory ∩ response| / |memory|), with the same weak threshold (0.1,
 *   `OVERLAP_WEAK_THRESHOLD` after FBK-4).
 * - The negative-keyword list is copied verbatim from feedback.rs
 *   `NEGATIVE_KEYWORDS`.
 */

/** feedback.rs OVERLAP_WEAK_THRESHOLD — at/above this a surfaced memory counts as used. */
export const OVERLAP_USED_THRESHOLD = 0.1;

/** Copied verbatim from src/memory/feedback.rs `NEGATIVE_KEYWORDS`. */
export const NEGATIVE_KEYWORDS: readonly string[] = [
	"wrong",
	"incorrect",
	"not correct",
	"nope",
	"not what i meant",
	"that's not right",
	"that's wrong",
	"i already said",
	"i told you",
	"i already told",
	"already mentioned",
	"not helpful",
	"not relevant",
	"not useful",
	"irrelevant",
	"useless",
	"doesn't help",
	"didn't help",
	"not related",
	"doesn't work",
	"didn't work",
	"broken",
	"still broken",
	"that failed",
	"forget that",
	"ignore that",
	"disregard",
	"stop suggesting",
	"don't show",
];

/** Mirror of feedback.rs `extract_entities_simple`. */
export function extractTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const word of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
		if (word.length > 2) tokens.add(word);
	}
	return tokens;
}

/** Mirror of feedback.rs `calculate_entity_overlap`: |memory ∩ response| / |memory|. */
export function memoryOverlap(memoryContent: string, responseTokens: Set<string>): number {
	const memoryTokens = extractTokens(memoryContent);
	if (memoryTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of memoryTokens) {
		if (responseTokens.has(token)) intersection += 1;
	}
	return intersection / memoryTokens.size;
}

/** Mirror of feedback.rs `detect_negative_keywords` (contains-match on lowercased text). */
export function detectNegativeKeywords(text: string): string[] {
	const lower = text.toLowerCase();
	return NEGATIVE_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

/**
 * Inline citations the system prompt asks the model to emit when a recalled
 * memory informs the answer: [mem:<first 8 hex chars of the id>].
 */
const CITATION_PATTERN = /\[mem:([0-9a-fA-F]{8})\]/g;

/** Extract cited memory-id prefixes from a response. */
export function extractCitations(text: string): Set<string> {
	const cited = new Set<string>();
	for (const match of text.matchAll(CITATION_PATTERN)) {
		const prefix = match[1];
		if (prefix) cited.add(prefix.toLowerCase());
	}
	return cited;
}
