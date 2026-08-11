import { useQuery } from "@tanstack/react-query";
import { probeSeat } from "@/lib/seat/client";
import type { SeatReachability } from "@/lib/seat/types";

/**
 * Seat reachability, polled like the backend's (useReachability) and for the
 * same reason: the seat is a local process someone starts by hand, so "not
 * running" is ordinary and the app must recover on its own when it comes up.
 * Kept separate from the backend probe because the two fail independently and
 * need different remedies in front of a person.
 */
export function useSeatHealth(): SeatReachability {
  const { data } = useQuery({
    queryKey: ["seat-health"],
    queryFn: ({ signal }) => probeSeat(signal),
    refetchInterval: 10_000,
    retry: false,
    staleTime: 0,
  });
  return data ?? { state: "offline", detail: "not probed yet" };
}
