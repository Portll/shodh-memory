import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";

/**
 * Server-state policy, in one place.
 *
 * The defaults matter more than usual here because the backend is routinely
 * absent — it is a local process a person starts by hand, so "not running" is
 * an ordinary state rather than an outage.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Retrying a 401 cannot help: the key is wrong and will still be
            // wrong. Retrying a network failure can, because the server may be
            // starting up. Anything else gets two attempts and then reports.
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.isAuthFailure) return false;
              return failureCount < 2;
            },
            // Recall is not cheap and its results are stable for a given
            // query, so refetching because a window regained focus would spend
            // real retrieval work to redraw the same list.
            refetchOnWindowFocus: false,
            staleTime: 30_000,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
