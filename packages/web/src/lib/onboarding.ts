import type { CompleteOnboarding } from "@sugabots/contracts";
import { unwrap } from "@sugabots/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";

export function useOnboarding() {
	return useQuery({
		queryKey: ["onboarding"],
		queryFn: () => unwrap(client.api.onboarding.$get()),
	});
}

export function useCompleteOnboarding() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (json: CompleteOnboarding) =>
			unwrap(client.api.onboarding.complete.$post({ json })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["onboarding"] }),
	});
}
