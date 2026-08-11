/**
 * MCP host: the seat's own MCP client, bridging remote and local MCP servers
 * into the pi agent loop.
 *
 * pi has no MCP client (packages/agent/src contains none; pi's README states
 * "No MCP" explicitly), so everything an MCP host has to do — transport
 * selection, the initialize handshake, tool listing, lifecycle, credentials —
 * is this file's job.
 *
 * TRANSPORTS. Three, matching what @modelcontextprotocol/sdk 1.30.0 actually
 * ships in dist/esm/client: stdio (spawn a command), streamable HTTP (the
 * current standard for remote servers), and HTTP+SSE (the superseded one,
 * marked @deprecated in the SDK but still the only thing a lot of deployed
 * servers speak). A remote server configured as "auto" — the default — is
 * tried over streamable HTTP first and falls back to SSE only when the
 * endpoint answers with a 4xx that means "I do not know this verb"
 * (404/405/406). It does NOT fall back on 401/403/429 or on a transport-level
 * failure: those mean the credential is wrong or the host is down, and
 * retrying the same failure over an older transport just doubles the wait
 * before showing the same error.
 *
 * LIFECYCLE, AND WHAT IS DELIBERATELY NOT BUILT. Every configured server is
 * retained with a status, whether or not it ever connected: "connecting",
 * "ready", "failed" (never got up — bad command, unreachable URL, missing
 * token) or "disconnected" (was up, went away). That distinction is the whole
 * point — a server with zero tools and a server that is dead read identically
 * if all you keep is a tool count. There is no automatic reconnection loop.
 * Of the three ways a server actually dies, two (a command that does not
 * exist, a credential that is not accepted) can never be fixed by retrying,
 * and the third (a restarted endpoint) is one click away in a UI that is
 * already showing the failure. A background retry loop against a
 * crash-looping child process is a well-known way to turn one broken config
 * into sustained load, and it would buy nothing here. What IS handled
 * automatically is the case with a protocol signal for it:
 * `notifications/tools/list_changed` re-lists that server's tools in place,
 * so a tool list is not frozen at boot.
 *
 * SECRETS. Header values configured for a remote server (`headers`, or
 * `headerEnv` resolved from this process's environment) are used to build
 * requests and are never stored anywhere they could be read back: the info
 * shape below carries header NAMES, and a URL is reported with its query
 * string and any userinfo stripped, because "?key=…" is a real way MCP
 * endpoints are authenticated.
 *
 * Schema note: MCP tools publish plain JSON Schema. pi's tool-argument
 * validation handles non-TypeBox schemas explicitly
 * (packages/ai/src/utils/validation.ts `validateToolArguments`, TYPEBOX_KIND
 * branch), so the inputSchema passes through unchanged.
 *
 * Tool names follow the mcp__<server>__<tool> convention used across this
 * repository's tooling.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, TSchema } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
	isRemoteMcpServer,
	MCP_SERVER_NAME_PATTERN,
	type McpRemoteServerConfig,
	type McpServerConfig,
} from "./config.js";

/** Which wire a server is (or would be) reached over. */
export type McpTransportKind = "stdio" | "http" | "sse";

/**
 * Where a configured server stands right now.
 *  - "connecting"   — an attempt is in flight.
 *  - "ready"        — handshake done, tools listed, calls will be attempted.
 *  - "failed"       — never came up. `error` says why.
 *  - "disconnected" — was ready, then the connection ended. `error` says why.
 */
export type McpServerStatus = "connecting" | "ready" | "failed" | "disconnected";

/** One tool as the server described it. Names only — nothing here has been
 *  called, and this file never implies otherwise. */
export interface McpToolInfo {
	name: string;
	title: string | null;
	description: string | null;
}

/** Full per-server report. Returned only from authenticated seat routes. */
export interface McpServerInfo {
	name: string;
	status: McpServerStatus;
	/** Resolved transport once an attempt has been made; the configured
	 *  preference before that ("auto" resolves to whichever one connects). */
	transport: McpTransportKind;
	tool_count: number;
	tools: McpToolInfo[];
	error: string | null;
	/** Remote servers: scheme, host and path. Never the query string, never
	 *  userinfo — both are places tokens are carried in practice. */
	endpoint: string | null;
	/** Local servers: the command line as configured, for "why did that not
	 *  start". Environment values are not included. */
	command: string | null;
	/** Names of the extra headers sent to a remote server; never their values.
	 *  Names are worth showing — "this endpoint is being sent an
	 *  Authorization header and still says 401" is the answer to a real
	 *  question — and follow the same precedent as ProviderInfo.source, which
	 *  reports the NAME of the environment variable a key came from. */
	auth_header_names: string[];
	/** What the server called itself in the initialize handshake. */
	server_name: string | null;
	server_version: string | null;
	connected_at: string | null;
	tools_listed_at: string | null;
	last_attempt_at: string | null;
}

/** The unauthenticated /healthz projection: existence and liveness, no
 *  endpoints, no error text (error strings can embed URLs). */
export interface McpServerHealth {
	name: string;
	status: McpServerStatus;
	tool_count: number;
}

/** Per-call ceiling for a bridged MCP tool. */
const CALL_TIMEOUT_MS = 120_000;
/** How much of a stdio server's stderr to keep for the failure message. A
 *  child that dies during startup says why on stderr and nowhere else; the
 *  previous implementation discarded it (`stderr: "ignore"`), which is how
 *  "MCP error -32000: Connection closed" became the whole diagnosis. */
const STDERR_TAIL_BYTES = 2048;
/** Status codes that mean "this endpoint does not speak streamable HTTP",
 *  as opposed to "your credential is wrong" or "you are being throttled". */
const SSE_FALLBACK_STATUSES = new Set([404, 405, 406]);

function nowIso(): string {
	return new Date().toISOString();
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A URL safe to report: scheme, host, path. Query strings and userinfo are
 *  dropped because both are used to carry credentials in the wild. */
function publicEndpoint(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.search = "";
		url.hash = "";
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		return "(unparseable url)";
	}
}

function mapContent(content: unknown): (TextContent | ImageContent)[] {
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const mapped: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block) {
			const typed = block as { type: string; text?: string; data?: string; mimeType?: string };
			if (typed.type === "text" && typeof typed.text === "string") {
				mapped.push({ type: "text", text: typed.text });
				continue;
			}
			if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
				mapped.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
				continue;
			}
		}
		mapped.push({ type: "text", text: JSON.stringify(block) });
	}
	return mapped.length > 0 ? mapped : [{ type: "text", text: "" }];
}

/** A tool as MCP lists it — the fields this bridge reads. */
interface ListedTool {
	name: string;
	description?: string;
	inputSchema: unknown;
	title?: string;
}

/** Raised when a model calls a tool whose server is no longer up. Named so the
 *  transcript records the real cause rather than a socket error from three
 *  layers down; the agent sees this text as the tool result. */
export class McpServerUnavailableError extends Error {
	constructor(serverName: string, status: McpServerStatus, reason: string | null) {
		super(
			`MCP server "${serverName}" is ${status === "failed" ? "not connected" : "no longer connected"}` +
				`${reason ? ` (${reason})` : ""} — reconnect it and try again`,
		);
		this.name = "McpServerUnavailableError";
	}
}

/**
 * Mutable per-server record. One of these exists for every configured server
 * from the moment the config is read, including servers that never connect —
 * that is what makes a failure visible instead of a silent absence.
 */
class ServerEntry {
	readonly config: McpServerConfig;
	transport: McpTransportKind;
	status: McpServerStatus = "connecting";
	error: string | null = null;
	tools: AgentTool<any>[] = [];
	listed: McpToolInfo[] = [];
	client: Client | null = null;
	/**
	 * Rolling tail of a stdio server's stderr.
	 *
	 * Held on the entry rather than in the connect closure so it can be CLEARED
	 * the moment the server is working. What is worth reporting differs by
	 * phase: before the handshake, the tail is the startup failure (a missing
	 * interpreter, an import error) and is the only diagnosis available; after
	 * it, the interesting text is whatever the child said on its way out, and
	 * carrying the startup banner forward would bury a crash trace under two
	 * kilobytes of "listening on…".
	 */
	stderr: { text: string } | null = null;
	serverName: string | null = null;
	serverVersion: string | null = null;
	connectedAt: string | null = null;
	toolsListedAt: string | null = null;
	lastAttemptAt: string | null = null;
	/** Set while this entry is being torn down on purpose, so the transport's
	 *  own close callback does not report a deliberate shutdown as a fault. */
	closing = false;
	/** In-flight connect, so two reconnects cannot race into two live clients. */
	pending: Promise<void> | null = null;
	/** Bumped on every connect attempt. Callbacks captured by an older attempt
	 *  compare against it and do nothing if they have been superseded. */
	generation = 0;

	constructor(config: McpServerConfig) {
		this.config = config;
		if (!isRemoteMcpServer(config)) {
			this.transport = "stdio";
		} else {
			this.transport = config.transport === "sse" ? "sse" : "http";
		}
	}

	info(): McpServerInfo {
		const config = this.config;
		const remote = isRemoteMcpServer(config) ? config : null;
		const commandLine = isRemoteMcpServer(config)
			? null
			: [config.command, ...(config.args ?? [])].join(" ");
		return {
			name: config.name,
			status: this.status,
			transport: this.transport,
			tool_count: this.listed.length,
			tools: this.listed,
			error: this.error,
			endpoint: remote ? publicEndpoint(remote.url) : null,
			command: commandLine,
			auth_header_names: remote
				? [...Object.keys(remote.headers ?? {}), ...Object.keys(remote.headerEnv ?? {})]
				: [],
			server_name: this.serverName,
			server_version: this.serverVersion,
			connected_at: this.connectedAt,
			tools_listed_at: this.toolsListedAt,
			last_attempt_at: this.lastAttemptAt,
		};
	}
}

export class McpHost {
	private readonly entries = new Map<string, ServerEntry>();
	private readonly connectTimeoutMs: number;
	/** Emitted for connection-lifecycle events that happen outside a request —
	 *  a server dropping mid-session has to reach the operator's log somehow. */
	private readonly log: (message: string) => void;

	constructor(options: { connectTimeoutMs: number; log?: (message: string) => void }) {
		this.connectTimeoutMs = options.connectTimeoutMs;
		this.log = options.log ?? ((message) => console.warn(message));
	}

	/**
	 * Register every configured server and connect to them concurrently.
	 *
	 * Concurrent, and awaited by the caller only for logging: one slow server —
	 * an `npx` that is fetching its package, an unreachable endpoint burning
	 * its full timeout — used to delay every other server behind it in the
	 * list. The seat's HTTP listener does not wait for this at all (index.ts),
	 * because a hung MCP endpoint must not decide when the product starts
	 * answering.
	 */
	async connect(configs: McpServerConfig[]): Promise<void> {
		const attempts: Promise<void>[] = [];
		for (const config of configs) {
			if (!MCP_SERVER_NAME_PATTERN.test(config.name)) {
				// Reachable when a caller builds configs itself rather than going
				// through parseMcpServers. Recorded, not thrown: one bad name must
				// not cost the operator every other server.
				const entry = new ServerEntry(config);
				entry.status = "failed";
				entry.error = `Invalid server name "${config.name}" (allowed: letters, digits, - and _)`;
				this.entries.set(config.name, entry);
				continue;
			}
			if (this.entries.has(config.name)) {
				const existing = this.entries.get(config.name);
				if (existing) existing.error = `Duplicate server name "${config.name}"; the first one was kept`;
				continue;
			}
			const entry = new ServerEntry(config);
			this.entries.set(config.name, entry);
			attempts.push(this.attempt(entry));
		}
		await Promise.all(attempts);
	}

	/**
	 * Re-run the connection for one server, from whatever state it is in.
	 * The manual half of the lifecycle: this is what a dead server's remedy is,
	 * instead of a retry loop nobody can see or stop.
	 */
	async reconnect(name: string): Promise<McpServerInfo> {
		const entry = this.entries.get(name);
		if (!entry) throw new UnknownMcpServerError(name);
		if (entry.pending) await entry.pending.catch(() => {});
		await this.teardown(entry);
		entry.status = "connecting";
		entry.error = null;
		await this.attempt(entry);
		return entry.info();
	}

	/** All bridged tools across servers that are currently up. */
	getTools(): AgentTool<any>[] {
		const tools: AgentTool<any>[] = [];
		for (const entry of this.entries.values()) {
			if (entry.status === "ready") tools.push(...entry.tools);
		}
		return tools;
	}

	/** Full detail. Authenticated routes only — carries endpoints and errors. */
	listServers(): McpServerInfo[] {
		return [...this.entries.values()].map((entry) => entry.info());
	}

	/** The /healthz projection: no endpoint, no error text. */
	healthSummary(): McpServerHealth[] {
		return [...this.entries.values()].map((entry) => ({
			name: entry.config.name,
			status: entry.status,
			tool_count: entry.listed.length,
		}));
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.entries.values()].map((entry) => this.teardown(entry)));
		this.entries.clear();
	}

	// ---------------------------------------------------------------- internals

	private attempt(entry: ServerEntry): Promise<void> {
		const run = this.connectEntry(entry).finally(() => {
			if (entry.pending === run) entry.pending = null;
		});
		entry.pending = run;
		return run;
	}

	private async connectEntry(entry: ServerEntry): Promise<void> {
		const generation = ++entry.generation;
		entry.status = "connecting";
		entry.lastAttemptAt = nowIso();
		try {
			const { client, transport } = isRemoteMcpServer(entry.config)
				? await this.connectRemote(entry, entry.config, generation)
				: await this.connectStdio(entry, generation);
			if (generation !== entry.generation) {
				// Superseded while we were connecting (a reconnect landed on top).
				await client.close().catch(() => {});
				return;
			}
			entry.client = client;
			entry.transport = transport;
			const identity = client.getServerVersion();
			entry.serverName = identity?.name ?? null;
			entry.serverVersion = identity?.version ?? null;
			entry.connectedAt = nowIso();
			entry.error = null;
			await this.refreshTools(entry, client);
			entry.status = "ready";
			// From here on, anything this child writes to stderr is post-startup
			// — which is what a later disconnect should quote. See ServerEntry.
			if (entry.stderr) entry.stderr.text = "";
		} catch (error) {
			if (generation !== entry.generation) return;
			entry.status = "failed";
			entry.error = messageOf(error);
			entry.client = null;
			entry.tools = [];
			entry.listed = [];
		}
	}

	/**
	 * Spawn a local MCP server and connect over stdio.
	 *
	 * stderr is piped rather than ignored, and its tail is folded into the
	 * failure message. A child that fails to start (missing interpreter, an
	 * import error, a bad path) says so on stderr and then exits, at which
	 * point the MCP layer only knows the pipe closed.
	 */
	private async connectStdio(
		entry: ServerEntry,
		generation: number,
	): Promise<{ client: Client; transport: McpTransportKind }> {
		const config = entry.config;
		if (isRemoteMcpServer(config)) throw new Error("internal: stdio path reached with a remote config");

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
			cwd: config.cwd,
			stderr: "pipe",
		});

		const tailBuffer = { text: "" };
		entry.stderr = tailBuffer;
		const stderr = transport.stderr;
		if (stderr) {
			// Must be drained whether or not anyone reads it: an unread pipe
			// eventually blocks the child on its own logging.
			stderr.on("data", (chunk: Buffer | string) => {
				tailBuffer.text = (tailBuffer.text + chunk.toString()).slice(-STDERR_TAIL_BYTES);
			});
			stderr.on("error", () => {});
		}

		const client = this.newClient(entry, generation);
		try {
			await this.withTimeout(entry, client, client.connect(transport));
		} catch (error) {
			const tail = tailBuffer.text.trim();
			throw new Error(
				`could not start "${config.command}${config.args?.length ? ` ${config.args.join(" ")}` : ""}": ` +
					`${messageOf(error)}${tail ? `\n${tail}` : ""}`,
			);
		}
		return { client, transport: "stdio" };
	}

	/**
	 * Dial a remote MCP server.
	 *
	 * "auto" tries streamable HTTP and falls back to SSE only on the statuses
	 * that mean the endpoint does not implement it. Each attempt gets its own
	 * Client: a client whose connect() rejected has already had start() called
	 * on a transport that is now dead, and reusing it produces a much more
	 * confusing second failure than the first one.
	 */
	private async connectRemote(
		entry: ServerEntry,
		config: McpRemoteServerConfig,
		generation: number,
	): Promise<{ client: Client; transport: McpTransportKind }> {
		const headers = this.resolveHeaders(config);
		const url = new URL(config.url);
		const preference = config.transport ?? "auto";

		if (preference !== "sse") {
			const client = this.newClient(entry, generation);
			try {
				// Both transports merge requestInit.headers into every request
				// they make, including the GET that opens the event stream
				// (client/streamableHttp.js `_commonHeaders`, client/sse.js
				// `_commonHeaders`), so one place covers auth for both.
				const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
				await this.withTimeout(entry, client, client.connect(transport));
				return { client, transport: "http" };
			} catch (error) {
				await client.close().catch(() => {});
				const status = error instanceof StreamableHTTPError ? error.code : undefined;
				const canFallBack =
					preference === "auto" && status !== undefined && SSE_FALLBACK_STATUSES.has(status);
				if (!canFallBack) {
					throw new Error(`${publicEndpoint(config.url)} (streamable HTTP): ${messageOf(error)}`);
				}
			}
		}

		const client = this.newClient(entry, generation);
		try {
			const transport = new SSEClientTransport(url, { requestInit: { headers } });
			await this.withTimeout(entry, client, client.connect(transport));
			return { client, transport: "sse" };
		} catch (error) {
			await client.close().catch(() => {});
			throw new Error(`${publicEndpoint(config.url)} (HTTP+SSE): ${messageOf(error)}`);
		}
	}

	/**
	 * Header values for a remote server. `headerEnv` entries name environment
	 * variables read from this process; an unset one aborts the connection with
	 * the variable's name in the message rather than dialling out unauthenticated
	 * and reporting whatever the server says about a missing token.
	 */
	private resolveHeaders(config: McpRemoteServerConfig): Record<string, string> {
		const headers: Record<string, string> = { ...(config.headers ?? {}) };
		const missing: string[] = [];
		for (const [header, variable] of Object.entries(config.headerEnv ?? {})) {
			const value = process.env[variable];
			if (value === undefined || value === "") {
				missing.push(variable);
				continue;
			}
			headers[header] = value;
		}
		if (missing.length > 0) {
			throw new Error(
				`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set in the seat's environment, ` +
					`and server "${config.name}" needs ${missing.length === 1 ? "it" : "them"} for its request headers`,
			);
		}
		return headers;
	}

	/**
	 * A client wired for this entry's lifecycle before it is connected, so no
	 * notification or close can arrive with nowhere to go.
	 */
	private newClient(entry: ServerEntry, generation: number): Client {
		const client = new Client({ name: "shodh-seat-harness", version: "0.1.0" });

		client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
			if (generation !== entry.generation || entry.status !== "ready") return;
			void this.refreshTools(entry, client).catch((error) => {
				this.log(`[seat] MCP server "${entry.config.name}" changed its tool list but re-listing failed: ${messageOf(error)}`);
			});
		});

		client.onclose = () => {
			// Only a connection that actually became this entry's live one can
			// "disconnect". Everything else that closes is an attempt being
			// cleaned up — a superseded generation, a deliberate teardown, or
			// the streamable-HTTP probe that a fallback-to-SSE server rejects on
			// its way to connecting successfully — and reporting any of those as
			// a fault would put a scary line in the log for a healthy server.
			if (generation !== entry.generation || entry.closing) return;
			if (entry.status !== "ready" || entry.client !== client) return;
			// So: an unexpected end of a working connection — a stdio child that
			// exited, an endpoint that dropped the session. Tools go with it, so
			// the next turn's tool list is honest about what is reachable.
			entry.status = "disconnected";
			entry.tools = [];
			entry.listed = [];
			entry.client = null;
			const tail = entry.stderr?.text.trim();
			entry.error = `connection closed${tail ? `: ${tail}` : ""}`;
			this.log(`[seat] MCP server "${entry.config.name}" disconnected — its tools are unavailable until it is reconnected`);
		};

		client.onerror = (error) => {
			if (generation !== entry.generation) return;
			// `error` means "the reason this server is not usable" — that is what
			// the workbench renders, and it must not be filled in for a server
			// that is working. Transport-level errors on a live connection are
			// frequently self-healing: an idle SSE stream hitting the HTTP
			// client's body timeout raises one and the EventSource then
			// reconnects, which would otherwise leave a connected server painted
			// as broken forever. Errors during a connection ATTEMPT do belong in
			// the field, because there the attempt is what failed.
			if (entry.status === "ready") {
				this.log(`[seat] MCP "${entry.config.name}" transport error (still connected): ${messageOf(error)}`);
				return;
			}
			entry.error = messageOf(error);
		};

		return client;
	}

	/**
	 * List every tool the server offers and rebuild this entry's bridged tools.
	 *
	 * Paginated deliberately: `Client.listTools` issues exactly one tools/list
	 * request and hands back whatever `nextCursor` came with it
	 * (client/index.js listTools) — it does not follow the cursor. shodh's own
	 * MCP server publishes dozens of tools, so a first-page-only bridge would
	 * lose tools with no error anywhere.
	 */
	private async refreshTools(entry: ServerEntry, client: Client): Promise<void> {
		const listed: ListedTool[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor ? { cursor } : undefined, {
				timeout: this.connectTimeoutMs,
			});
			listed.push(...(page.tools as ListedTool[]));
			cursor = page.nextCursor;
		} while (cursor);

		entry.tools = listed.map((tool) => this.toAgentTool(entry, tool));
		entry.listed = listed.map((tool) => ({
			name: tool.name,
			title: tool.title ?? null,
			description: tool.description ?? null,
		}));
		entry.toolsListedAt = nowIso();
	}

	private toAgentTool(entry: ServerEntry, tool: ListedTool): AgentTool<any> {
		const serverName = entry.config.name;
		return {
			name: `mcp__${serverName}__${tool.name}`,
			label: tool.title ?? tool.name,
			description: tool.description ?? `${tool.name} (MCP tool from ${serverName})`,
			// Plain JSON Schema; pi validates it via its non-TypeBox branch.
			parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as TSchema,
			execute: async (_toolCallId, params, signal): Promise<AgentToolResult<unknown>> => {
				// The entry, not a captured client: a turn can outlive the
				// connection it started under, and calling into a closed client
				// surfaces a transport error instead of the actual situation.
				const client = entry.status === "ready" ? entry.client : null;
				if (!client) throw new McpServerUnavailableError(serverName, entry.status, entry.error);
				const result = await client.callTool(
					{ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
					undefined,
					{ timeout: CALL_TIMEOUT_MS, signal },
				);
				const content = mapContent(result.content);
				if (result.isError) {
					const text = content
						.map((block) => (block.type === "text" ? block.text : "<image>"))
						.join("\n")
						.trim();
					throw new Error(text || `MCP tool ${tool.name} failed`);
				}
				return {
					content,
					details: result.structuredContent ?? undefined,
				};
			},
		};
	}

	/**
	 * Bound the connect handshake.
	 *
	 * The SDK's own request timeout covers the initialize round-trip once a
	 * transport is up, but neither `fetch` nor a child-process spawn has a
	 * deadline of its own: an endpoint that accepts a socket and then says
	 * nothing, or a command that starts and never speaks MCP, would otherwise
	 * hold this entry in "connecting" forever. On expiry the client is closed
	 * so the socket or child does not outlive the attempt.
	 */
	private async withTimeout(entry: ServerEntry, client: Client, work: Promise<void>): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`no response within ${Math.round(this.connectTimeoutMs / 1000)}s`));
			}, this.connectTimeoutMs);
		});
		try {
			await Promise.race([work, deadline]);
		} catch (error) {
			entry.closing = true;
			await client.close().catch(() => {});
			entry.closing = false;
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Close a server's connection deliberately, without the close callback
	 *  reporting the shutdown as a fault. */
	private async teardown(entry: ServerEntry): Promise<void> {
		entry.generation += 1;
		const client = entry.client;
		entry.client = null;
		entry.tools = [];
		entry.listed = [];
		if (!client) return;
		entry.closing = true;
		try {
			await client.close();
		} catch {
			// A connection that is already gone is exactly what we wanted.
		} finally {
			entry.closing = false;
		}
	}
}

export class UnknownMcpServerError extends Error {
	constructor(name: string) {
		super(`Unknown MCP server: ${name}`);
		this.name = "UnknownMcpServerError";
	}
}
