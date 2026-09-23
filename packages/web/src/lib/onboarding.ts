import type { CompleteOnboarding } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

export function useOnboarding() {
	return useQuery({
		queryKey: ["onboarding"],
		queryFn: ({ signal }) => Effect.runPromise(client.api.onboarding.status(), { signal }),
	});
}

export function useCompleteOnboarding() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (payload: CompleteOnboarding) =>
			Effect.runPromise(client.api.onboarding.complete({ payload })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["onboarding"] }),
	});
}
