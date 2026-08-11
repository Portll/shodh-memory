/**
 * Model registry: pi's full built-in provider catalog plus local
 * OpenAI-compatible endpoints (Ollama, LM Studio) as first-class providers.
 *
 * pi ships no local-model provider (packages/ai/src/providers/ has none), but
 * every `Model` carries its own `baseUrl` (packages/ai/src/types.ts) and the
 * openai-completions API implementation uses it directly
 * (packages/ai/src/api/openai-completions.ts → `baseURL: model.baseUrl`), so a
 * local endpoint is just a custom provider built with `createProvider` +
 * `openAICompletionsApi()` and dynamic model discovery via GET {baseUrl}/models.
 *
 * Provider API keys resolve from environment variables inside this process
 * (pi's env auth). They are never sent to, or readable by, any client.
 */

import {
	type Api,
	type AuthCheck,
	createProvider,
	type CredentialStore,
	type Model,
	type MutableModels,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SeatConfig } from "./config.js";

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	context_window: number;
	max_tokens: number;
	reasoning: boolean;
	local: boolean;
	/**
	 * What a token means for this model UNDER ITS EFFECTIVE CREDENTIAL:
	 *  - "none"         — local endpoint; nothing leaves the machine, no bill.
	 *  - "subscription" — OAuth against a flat-rate plan (pi's
	 *    `OAuthAuth.isSubscription`); tokens count against a plan, and pi's
	 *    per-token cost numbers do NOT describe a bill.
	 *  - "metered"      — API key; pi's cost numbers are the bill.
	 * Derived from `checkAuth` at listing time, so it tracks whichever
	 * credential actually resolves (a stored OAuth login beats an env key).
	 */
	billing: "none" | "subscription" | "metered";
}

/**
 * Non-secret provider status for the sign-in surface. `source` is pi's own
 * label for where working auth came from ("ANTHROPIC_API_KEY", "OAuth",
 * "stored key", "local endpoint (keyless)", …); no key material ever leaves
 * this process.
 */
export interface ProviderInfo {
	id: string;
	name: string;
	/** Whether this provider currently has complete, usable auth. */
	configured: boolean;
	source: string | null;
	auth_type: "api_key" | "oauth" | null;
	/** A credential is stored in the seat's own credential file. */
	stored: boolean;
	/** Whether submitting an API key through the seat is meaningful for this
	 *  provider (pi models it as `auth.apiKey.login` being present; ambient-only
	 *  providers such as Bedrock/Vertex resolve from AWS/ADC files instead). */
	accepts_api_key: boolean;
	/** Whether pi ships a browser OAuth flow for this provider. */
	oauth_available: boolean;
	/** OAuth here is a flat-rate plan (Claude Pro/Max, ChatGPT, Copilot…). */
	oauth_subscription: boolean;
	/** pi's own label for the OAuth option, e.g. "Claude Pro/Max". */
	oauth_label: string | null;
	model_count: number;
	local: boolean;
}

/**
 * Providers served from this machine. Membership here is what makes a provider
 * keyless, billed as "none" and flagged `local` — all three fall out of this
 * list rather than being restated per provider, so adding an id is the whole
 * change.
 */
const LOCAL_PROVIDER_IDS = ["ollama", "lmstudio", "vllm"] as const;

interface LocalProviderOptions {
	id: (typeof LOCAL_PROVIDER_IDS)[number];
	name: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
}

/** Response shape of the OpenAI-compatible model listing endpoint (GET /v1/models). */
interface OpenAiModelList {
	data?: { id?: unknown }[];
}

function localModel(options: LocalProviderOptions, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: options.id,
		baseUrl: options.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow,
		maxTokens: options.maxTokens,
	};
}

async function fetchLocalModels(
	options: LocalProviderOptions,
	context: RefreshModelsContext,
): Promise<readonly Model<"openai-completions">[]> {
	const response = await fetch(`${options.baseUrl}/models`, {
		signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
	});
	if (!response.ok) {
		throw new Error(`${options.name} model listing failed: HTTP ${response.status}`);
	}
	const payload = (await response.json()) as OpenAiModelList;
	const ids = (payload.data ?? [])
		.map((entry) => entry.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	return ids.map((id) => localModel(options, id));
}

function localProvider(options: LocalProviderOptions): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: options.id,
		name: options.name,
		baseUrl: options.baseUrl,
		auth: {
			// Keyless local endpoint: resolve always succeeds so the provider is
			// "configured"; the placeholder key satisfies clients that require
			// a bearer token (Ollama and LM Studio both ignore it).
			apiKey: {
				name: `${options.name} endpoint`,
				resolve: async () => ({ auth: { apiKey: "local" }, source: "local endpoint (keyless)" }),
			},
		},
		models: [],
		fetchModels: (context) => fetchLocalModels(options, context),
		api: openAICompletionsApi(),
	});
}

export class ModelRegistry {
	readonly models: MutableModels;
	private readonly credentials: CredentialStore;

	constructor(config: SeatConfig, credentials: CredentialStore) {
		this.credentials = credentials;
		// A stored credential owns the provider; env vars are the fallback
		// (packages/ai/src/auth/resolve.ts). Keys submitted through the seat's
		// sign-in surface therefore take effect without a restart.
		this.models = builtinModels({ credentials });
		this.models.setProvider(
			localProvider({
				id: "ollama",
				name: "Ollama",
				baseUrl: config.ollamaBaseUrl,
				contextWindow: config.localContextWindow,
				maxTokens: config.localMaxTokens,
			}),
		);
		this.models.setProvider(
			localProvider({
				id: "lmstudio",
				name: "LM Studio",
				baseUrl: config.lmStudioBaseUrl,
				contextWindow: config.localContextWindow,
				maxTokens: config.localMaxTokens,
			}),
		);
		// vLLM serves the same OpenAI-compatible surface as the other two —
		// `vllm serve` mounts /v1/models and /v1/chat/completions — so it needs
		// no separate discovery path. It is the one of the three built for
		// throughput serving rather than desktop use, which is what makes it
		// worth having: the same conversation can run against a workstation's
		// batching server without leaving the machine.
		this.models.setProvider(
			localProvider({
				id: "vllm",
				name: "vLLM",
				baseUrl: config.vllmBaseUrl,
				contextWindow: config.localContextWindow,
				maxTokens: config.localMaxTokens,
			}),
		);
	}

	/**
	 * Refresh local-endpoint model listings. Errors are returned, not thrown:
	 * an offline Ollama must not take the seat down.
	 */
	async refreshLocal(): Promise<Record<string, string>> {
		const result = await this.models.refresh({ providers: [...LOCAL_PROVIDER_IDS] });
		const errors: Record<string, string> = {};
		for (const [provider, error] of result.errors) {
			errors[provider] = error.message;
		}
		return errors;
	}

	/** Models whose providers have working auth (env keys present, or local). */
	async listAvailable(): Promise<ModelInfo[]> {
		const available = await this.models.getAvailable();
		// Billing semantics per provider, from the credential that actually
		// resolves right now — computed once per provider, not per model.
		const billingByProvider = new Map<string, ModelInfo["billing"]>();
		for (const model of available) {
			if (billingByProvider.has(model.provider)) continue;
			if ((LOCAL_PROVIDER_IDS as readonly string[]).includes(model.provider)) {
				billingByProvider.set(model.provider, "none");
				continue;
			}
			let billing: ModelInfo["billing"] = "metered";
			try {
				const check = await this.models.checkAuth(model.provider);
				const provider = this.models.getProvider(model.provider);
				if (check?.type === "oauth" && provider?.auth.oauth?.isSubscription) {
					billing = "subscription";
				}
			} catch {
				// Unresolvable check ⇒ default to metered; never invent "free".
			}
			billingByProvider.set(model.provider, billing);
		}
		return available.map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			context_window: model.contextWindow,
			max_tokens: model.maxTokens,
			reasoning: model.reasoning,
			local: (LOCAL_PROVIDER_IDS as readonly string[]).includes(model.provider),
			billing: billingByProvider.get(model.provider) ?? "metered",
		}));
	}

	resolve(provider: string, id: string): Model<Api> | undefined {
		return this.models.getModel(provider, id);
	}

	/** Provider status for the sign-in surface. Never exposes key material. */
	async listProviders(): Promise<ProviderInfo[]> {
		const stored = new Set((await this.credentials.list()).map((info) => info.providerId));
		const providers: ProviderInfo[] = [];
		for (const provider of this.models.getProviders()) {
			// checkAuth is a presence check (env/stored/ambient), not a network
			// round-trip. A provider whose check throws (malformed ambient
			// config) reads as unconfigured rather than taking the listing down.
			let check: AuthCheck | undefined;
			try {
				check = await this.models.checkAuth(provider.id);
			} catch {
				check = undefined;
			}
			const local = (LOCAL_PROVIDER_IDS as readonly string[]).includes(provider.id);
			providers.push({
				id: provider.id,
				name: provider.name,
				configured: check !== undefined,
				source: check?.source ?? null,
				auth_type: check?.type ?? null,
				stored: stored.has(provider.id),
				accepts_api_key: !local && Boolean(provider.auth.apiKey?.login),
				oauth_available: !local && provider.auth.oauth !== undefined,
				oauth_subscription: Boolean(provider.auth.oauth?.isSubscription),
				oauth_label: provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name ?? null,
				model_count: this.models.getModels(provider.id).length,
				local,
			});
		}
		providers.sort((a, b) => a.name.localeCompare(b.name));
		return providers;
	}

	/**
	 * Store an API key for a provider, server-side. The key becomes the working
	 * credential immediately (stored beats env in pi's resolution order).
	 * Returns the provider's post-write status.
	 */
	async setApiKey(providerId: string, apiKey: string): Promise<ProviderInfo> {
		const provider = this.models.getProvider(providerId);
		if (!provider) throw new UnknownProviderError(providerId);
		if ((LOCAL_PROVIDER_IDS as readonly string[]).includes(providerId) || !provider.auth.apiKey?.login) {
			throw new ProviderKeyUnsupportedError(providerId);
		}
		await this.credentials.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
		return this.providerInfo(providerId);
	}

	/** Remove the stored credential (env-var auth, if any, remains). */
	async clearCredential(providerId: string): Promise<ProviderInfo> {
		const provider = this.models.getProvider(providerId);
		if (!provider) throw new UnknownProviderError(providerId);
		await this.models.logout(providerId);
		return this.providerInfo(providerId);
	}

	private async providerInfo(providerId: string): Promise<ProviderInfo> {
		const info = (await this.listProviders()).find((provider) => provider.id === providerId);
		if (!info) throw new UnknownProviderError(providerId);
		return info;
	}
}

export class UnknownProviderError extends Error {
	constructor(providerId: string) {
		super(`Unknown provider: ${providerId}`);
		this.name = "UnknownProviderError";
	}
}

export class ProviderKeyUnsupportedError extends Error {
	constructor(providerId: string) {
		super(
			`Provider ${providerId} does not take an API key here — it authenticates ambiently ` +
				`(local endpoint, AWS profile, or application-default credentials)`,
		);
		this.name = "ProviderKeyUnsupportedError";
	}
}
