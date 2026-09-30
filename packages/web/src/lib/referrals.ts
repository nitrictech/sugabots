import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

const referralLinkKey = ["referral-link"];

/** The signed-in person's referral link, `null` where the installation does not sign people up by referral. */
export function useReferralLink() {
	return useQuery({
		queryKey: referralLinkKey,
		queryFn: ({ signal }) => Effect.runPromise(client.api.referrals.link(), { signal }),
		select: ({ url }) => url,
	});
}

/** Replaces the signed-in person's referral link; the one they had stops working. */
export function useResetReferralLink() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: () => Effect.runPromise(client.api.referrals.resetLink()),
		onSuccess: (link) => queries.setQueryData(referralLinkKey, link),
	});
}
