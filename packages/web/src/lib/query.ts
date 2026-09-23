import { isApiFailure } from "@sugabots/sdk";
import { QueryClient } from "@tanstack/react-query";

/**
 * The query cache.
 *
 * One client for the process, created outside React so it survives re-renders
 * and so tests can hand a fresh one to each case.
 *
 * Two defaults worth explaining:
 *
 * - **No retry on a failure the API meant.** A 404 or a 403 is an answer, not a
 *   network blip; retrying it three times only delays showing the person what
 *   happened. Anything else — a dropped connection, a 500 — is retried once.
 * - **`staleTime` of thirty seconds.** Lists like the sidebar's pods change
 *   rarely and are read on every navigation. Once the workspace stream carries
 *   `pod.changed` (NIT-1792 adds the first of these), invalidation replaces
 *   the guess and this can go to `Infinity`.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: (attempt, failure) =>
					attempt < 1 && !(isApiFailure(failure) && failure._tag !== "InternalServerError"),
			},
			mutations: { retry: false },
		},
	});
}

/**
 * findWithCachedQueries returns a cached match while stale queries refresh in
 * the background. If find returns undefined, it retries once with fresh queries.
 */
export async function findWithCachedQueries<Result>(
	queryClient: QueryClient,
	find: (readQuery: QueryClient["fetchQuery"]) => Promise<Result>,
): Promise<Result> {
	const cached = await find((options) =>
		queryClient.ensureQueryData({ ...options, revalidateIfStale: true }),
	);
	if (cached !== undefined) return cached;
	return find((options) => queryClient.fetchQuery({ ...options, staleTime: 0 }));
}
