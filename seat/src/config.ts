/**
 * Seat harness configuration, resolved from environment variables.
 *
 * Backend resolution mirrors mcp-server/index.ts:
 *   SHODH_API_URL > SHODH_HOST+SHODH_PORT > http://127.0.0.1:3030
 * API key resolution mirrors mcp-server/index.ts:
 *   SHODH_API_KEY > SHODH_DEV_API_KEY > first entry of SHODH_API_KEYS
 * (No auto-generation here: unlike the MCP server, the seat does not spawn the
 * backend, so a generated key would never match a running server.)
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * An MCP server the seat should connect to, as written in the JSON file named
 * by SEAT_MCP_SERVERS.
 *
 * Two genuinely different things, so two shapes rather than one shape with
 * half its fields ignored: a server the seat SPAWNS (a command on this
 * machine, talking over stdio) and a server the seat DIALS (a URL someone else
 * hosts). The union is discriminated structurally on `command` vs `url` —
 * `transport` only ever refines the remote case — because that is what a
 * person actually writes, and a config that names both is a mistake worth
 * rejecting rather than resolving by precedence.
 */
export interface McpStdioServerConfig {
	/** Short identifier used in tool-name prefixes: [a-zA-Z0-9_-]+ */
	name: string;
	transport?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpRemoteServerConfig {
	/** Short identifier used in tool-name prefixes: [a-zA-Z0-9_-]+ */
	name: string;
	/**
	 * "http" is the current standard transport (streamable HTTP). "sse" is the
	 * superseded one, kept because deployed servers still speak only it. The
	 * default, "auto", tries streamable HTTP and falls back to SSE when the
	 * endpoint answers that it does not know the newer verb — see mcp.ts.
	 */
	transport?: "http" | "sse" | "auto";
	url: string;
	/**
	 * Extra request headers, verbatim. Values are secrets as often as not, so
	 * they live in this server-side file and are never echoed anywhere: the
	 * seat's own API reports header NAMES at most.
	 */
	headers?: Record<string, string>;
	/**
	 * Header name → environment-variable name, resolved in this process at
	 * connect time. The reason to prefer this over `headers` is that it keeps
	 * the token out of the config file entirely, which matters because that
	 * file is the thing most likely to be copied into a repository. A named
	 * variable that is unset is a connection ERROR, never a quiet
	 * unauthenticated attempt — a 401 three layers down is a much worse way to
	 * learn that an export was missing.
	 */
	headerEnv?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export function isRemoteMcpServer(config: McpServerConfig): config is McpRemoteServerConfig {
	return "url" in config;
}

/** Server-name grammar. Shared with mcp.ts, which builds `mcp__<name>__<tool>`
 *  tool identifiers out of it — anything looser produces tool names a model
 *  cannot reliably reproduce. */
export const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const REMOTE_TRANSPORTS = ["http", "sse", "auto"] as const;

function describeEntry(index: number, name: unknown): string {
	return typeof name === "string" && name ? `server "${name}"` : `server #${index + 1}`;
}

/**
 * Validate the SEAT_MCP_SERVERS payload. Every failure names the offending
 * entry and what was expected: this file is hand-written, and a typo in it
 * silently costs the agent every tool on that server.
 */
export function parseMcpServers(raw: string, source: string): McpServerConfig[] {
	let parsed: { servers?: unknown };
	try {
		parsed = JSON.parse(raw) as { servers?: unknown };
	} catch (error) {
		throw new Error(`${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!Array.isArray(parsed.servers)) {
		throw new Error(
			`${source}: expected { "servers": [ … ] } — each entry either ` +
				`{ name, command, args?, env?, cwd? } for a local command, or ` +
				`{ name, url, transport?, headers?, headerEnv? } for a remote endpoint`,
		);
	}

	const seen = new Set<string>();
	const servers: McpServerConfig[] = [];
	for (const [index, entry] of parsed.servers.entries()) {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`${source}: ${describeEntry(index, undefined)} is not an object`);
		}
		const candidate = entry as Record<string, unknown>;
		const name = candidate.name;
		if (typeof name !== "string" || !MCP_SERVER_NAME_PATTERN.test(name)) {
			throw new Error(
				`${source}: ${describeEntry(index, name)} needs a "name" of letters, digits, - or _ ` +
					`(it becomes part of every tool name the model sees)`,
			);
		}
		if (seen.has(name)) throw new Error(`${source}: two servers are both named "${name}"`);
		seen.add(name);

		const hasCommand = typeof candidate.command === "string" && candidate.command.length > 0;
		const hasUrl = typeof candidate.url === "string" && candidate.url.length > 0;
		if (hasCommand && hasUrl) {
			throw new Error(`${source}: server "${name}" sets both "command" and "url" — it can only be one of the two`);
		}
		if (!hasCommand && !hasUrl) {
			throw new Error(`${source}: server "${name}" needs a "command" (local) or a "url" (remote)`);
		}

		if (hasCommand) {
			if (candidate.transport !== undefined && candidate.transport !== "stdio") {
				throw new Error(
					`${source}: server "${name}" runs a command, so its transport is stdio — ` +
						`"${String(candidate.transport)}" needs a "url" instead`,
				);
			}
			servers.push(entry as McpStdioServerConfig);
			continue;
		}

		const transport = candidate.transport;
		if (transport !== undefined && !(REMOTE_TRANSPORTS as readonly unknown[]).includes(transport)) {
			throw new Error(
				`${source}: server "${name}" has transport "${String(transport)}" — expected ` +
					`${REMOTE_TRANSPORTS.map((value) => `"${value}"`).join(", ")}`,
			);
		}
		let url: URL;
		try {
			url = new URL(candidate.url as string);
		} catch {
			throw new Error(`${source}: server "${name}" has a "url" that is not a URL: ${String(candidate.url)}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`${source}: server "${name}" must use http:// or https://, not ${url.protocol}`);
		}
		servers.push(entry as McpRemoteServerConfig);
	}
	return servers;
}

export interface SeatConfig {
	/** shodh-memory Rust backend base URL (no trailing slash). */
	apiUrl: string;
	/** X-API-Key value for the backend. */
	apiKey: string;
	/** Bind host of the seat HTTP server. */
	host: string;
	/** Bind port of the seat HTTP server. */
	port: number;
	/** Bearer token required on seat endpoints. Mandatory for non-loopback binds. */
	authToken?: string;
	/** Directory for the learning ledger and other durable seat state. */
	dataDir: string;
	/** OpenAI-compatible base URL for Ollama (its /v1 endpoint). */
	ollamaBaseUrl: string;
	/** OpenAI-compatible base URL for LM Studio. */
	lmStudioBaseUrl: string;
	/** OpenAI-compatible base URL for vLLM (`vllm serve` mounts OpenAI routes
	 *  under /v1 and defaults to port 8000). */
	vllmBaseUrl: string;
	/** Context window advertised for locally served models (they do not report one). */
	localContextWindow: number;
	/** Max output tokens for locally served models. */
	localMaxTokens: number;
	/** Optional path to a JSON file: { "servers": McpServerConfig[] } */
	mcpConfigPath?: string;
	/** How long one MCP server gets to start, handshake and list its tools.
	 *  Generous by default: a stdio server launched through `npx`/`uvx` may be
	 *  downloading its own package on first run. */
	mcpConnectTimeoutMs: number;
	/** Backend request timeout in milliseconds. */
	backendTimeoutMs: number;
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function resolveApiUrl(env: NodeJS.ProcessEnv): string {
	if (env.SHODH_API_URL) return env.SHODH_API_URL.replace(/\/+$/, "");
	const host = env.SHODH_HOST;
	const port = env.SHODH_PORT;
	if (host) {
		const scheme = port === "443" ? "https" : "http";
		const portSuffix = port && port !== "443" && port !== "80" ? `:${port}` : "";
		return `${scheme}://${host}${portSuffix}`;
	}
	if (port) return `http://127.0.0.1:${port}`;
	return "http://127.0.0.1:3030";
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
	if (env.SHODH_API_KEY) return env.SHODH_API_KEY;
	if (env.SHODH_DEV_API_KEY) return env.SHODH_DEV_API_KEY;
	const first = env.SHODH_API_KEYS?.split(",")[0]?.trim();
	if (first) return first;
	return "";
}

/**
 * Default data directory. Deliberately NOT under the repository or any
 * cloud-synced/user-watched folder: file watchers have been observed to
 * corrupt append-heavy stores on this project (see
 * finding-bm25-onedrive-silent-commit-loss). LOCALAPPDATA on Windows,
 * XDG data dir elsewhere.
 */
function defaultDataDir(env: NodeJS.ProcessEnv): string {
	if (process.platform === "win32") {
		const base = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		return path.join(base, "shodh", "seat-harness");
	}
	const base = env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
	return path.join(base, "shodh", "seat-harness");
}

function parseIntEnv(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid ${name}: "${value}" (expected a positive integer)`);
	}
	return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SeatConfig {
	const apiKey = resolveApiKey(env);
	if (!apiKey) {
		throw new Error(
			"No backend API key configured. Set SHODH_API_KEY (or SHODH_DEV_API_KEY / SHODH_API_KEYS) " +
				"to the key the shodh-memory server accepts.",
		);
	}

	const host = env.SEAT_HOST ?? "127.0.0.1";
	const authToken = env.SEAT_AUTH_TOKEN?.trim() || undefined;
	if (!isLoopback(host) && !authToken) {
		throw new Error(
			`SEAT_HOST=${host} is not loopback; refusing to start without SEAT_AUTH_TOKEN. ` +
				"Provider credentials live in this process — never expose it unauthenticated.",
		);
	}

	return {
		apiUrl: resolveApiUrl(env),
		apiKey,
		host,
		port: parseIntEnv(env.SEAT_PORT, 3141, "SEAT_PORT"),
		authToken,
		dataDir: env.SEAT_DATA_DIR ?? defaultDataDir(env),
		ollamaBaseUrl: (env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/+$/, ""),
		lmStudioBaseUrl: (env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1").replace(/\/+$/, ""),
		vllmBaseUrl: (env.VLLM_BASE_URL ?? "http://127.0.0.1:8000/v1").replace(/\/+$/, ""),
		localContextWindow: parseIntEnv(env.SEAT_LOCAL_CONTEXT_WINDOW, 32768, "SEAT_LOCAL_CONTEXT_WINDOW"),
		localMaxTokens: parseIntEnv(env.SEAT_LOCAL_MAX_TOKENS, 8192, "SEAT_LOCAL_MAX_TOKENS"),
		mcpConfigPath: env.SEAT_MCP_SERVERS,
		mcpConnectTimeoutMs: parseIntEnv(env.SEAT_MCP_CONNECT_TIMEOUT_MS, 30000, "SEAT_MCP_CONNECT_TIMEOUT_MS"),
		backendTimeoutMs: parseIntEnv(env.SEAT_BACKEND_TIMEOUT_MS, 30000, "SEAT_BACKEND_TIMEOUT_MS"),
	};
}
