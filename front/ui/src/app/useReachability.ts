import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { isHumanProfile, probeBackend, type Reachability } from "@/lib/api";
import { useSession } from "@/stores/session";

/**
 * Connection state, polled, with the profile list it carries.
 *
 * Polling exists so the app recovers on its own when the backend comes up
 * instead of needing a reload — the common case is someone starting the server
 * after opening the page.
 */
export function useReachability(): Reachability {
  const reconcileProfiles = useSession((s) => s.reconcileProfiles);

  const { data } = useQuery({
    queryKey: ["reachability"],
    queryFn: ({ signal }) => probeBackend(signal),
    refetchInterval: 10_000,
    // This query resolves rather than throws for every expected state, so a
    // rejection here is a real bug and should not be retried into silence.
    retry: false,
    staleTime: 0,
  });

  const reach: Reachability = data ?? { state: "offline", detail: "not probed yet" };

  // The array's identity changes on every poll even when its contents do not,
  // so the effect depends on a serialisation of the contents rather than on the
  // array itself. Without this it re-runs ten times a minute forever.
  const profileKey = JSON.stringify(
    reach.state === "online" ? reach.profiles.filter(isHumanProfile) : [],
  );

  useEffect(() => {
    reconcileProfiles(JSON.parse(profileKey) as string[]);
  }, [profileKey, reconcileProfiles]);

  return reach;
}
