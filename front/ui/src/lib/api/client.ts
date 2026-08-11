/**
 * The one place a network call is made.
 *
 * Every request goes to a same-origin `/api/*` path. In production the
 * shodh-front Rust binary reverse-proxies those to SHODH_API_URL and injects
 * X-API-Key; in dev, vite.config.ts does the same. The browser therefore never
 * holds the API key, which is why no key handling appears anywhere in this
 * directory.
 *
 * Endpoints are added here only after reading their handler in `src/handlers/`.
 * Response shapes are not guessed — every type in `types.ts` cites the Rust
 * struct it mirrors.
 */

/** A request that reached the server and came back with a non-2xx status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`API ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
  }

  /** The server is up and answered, but rejected our key. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

/** The request never reached a server — down, DNS, aborted, offline. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "unreachable");
    this.name = "NetworkError";
  }
}

/**
 * These two are distinguished everywhere because they need different words in
 * front of a person: a 401 means "fix your key", a network failure means "start
 * the server". Collapsing them is what produced the old UI's habit of telling
 * people to check their network when the backend simply was not running.
 */
async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (cause) {
    // An abort is a caller decision, not a server problem. Rethrow it
    // unchanged so react-query treats it as a cancellation rather than a
    // failure worth retrying.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new NetworkError(cause);
  }

  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal }),
  post: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), signal }),
};
