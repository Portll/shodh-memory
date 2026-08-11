/**
 * File-backed pi `CredentialStore` for the seat.
 *
 * pi's `Models` accepts a credential store (`CreateModelsOptions.credentials`,
 * packages/ai/src/models.ts) and consults it BEFORE ambient env vars
 * (packages/ai/src/auth/resolve.ts: "A stored credential owns the provider;
 * ambient/env is consulted only when nothing is stored"). Injecting this store
 * is therefore all it takes for a key submitted through the sign-in surface to
 * become the working credential for that provider's models.
 *
 * Storage: one JSON file in SEAT_DATA_DIR next to the ledger and the
 * conversation store — server-side, never sent to a client. Writes go through
 * a temp file + rename so a crash mid-write cannot tear the file, and the file
 * is chmod 0600 (effective on POSIX; on Windows the data dir is already under
 * the user's LOCALAPPDATA profile ACL).
 *
 * Concurrency: pi requires `modify` to be a serialized read-modify-write (it
 * runs OAuth refresh inside it). A single promise chain serializes every
 * mutation; the seat is the only process that opens this file.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

interface CredentialFile {
	version: 1;
	providers: Record<string, Credential>;
}

export class FileCredentialStore implements CredentialStore {
	private readonly filePath: string;
	private cache: Record<string, Credential>;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(dataDir: string) {
		fs.mkdirSync(dataDir, { recursive: true });
		this.filePath = path.join(dataDir, "provider-credentials.json");
		this.cache = this.loadSync();
	}

	private loadSync(): Record<string, Credential> {
		let raw: string;
		try {
			raw = fs.readFileSync(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		const parsed = JSON.parse(raw) as CredentialFile;
		if (parsed.version !== 1 || typeof parsed.providers !== "object" || parsed.providers === null) {
			throw new Error(`${this.filePath}: unrecognized credential file format`);
		}
		return { ...parsed.providers };
	}

	private async persist(): Promise<void> {
		const payload: CredentialFile = { version: 1, providers: this.cache };
		const tmpPath = `${this.filePath}.tmp`;
		await fsp.writeFile(tmpPath, JSON.stringify(payload, null, "\t"), { encoding: "utf8", mode: 0o600 });
		await fsp.rename(tmpPath, this.filePath);
		// Rename preserves the temp file's 0600 on POSIX; enforce anyway in case
		// an earlier version of the file existed with wider permissions.
		await fsp.chmod(this.filePath, 0o600).catch(() => {});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const queued = this.chain.then(
			() => task(),
			() => task(),
		);
		this.chain = queued.catch(() => {});
		return queued;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.cache[providerId];
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(this.cache).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(async () => {
			options?.signal?.throwIfAborted();
			const current = this.cache[providerId];
			const next = await fn(current);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.cache[providerId] = next;
				await this.persist();
			}
			return next ?? current;
		});
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.enqueue(async () => {
			options?.signal?.throwIfAborted();
			if (!(providerId in this.cache)) return;
			delete this.cache[providerId];
			await this.persist();
		});
	}
}
