import type { ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";

export function useConnections(podId: string) {
	return useQuery({
		queryKey: ["connections", podId],
		queryFn: () => unwrap(client.api.pods[":podId"].connections.$get({ param: { podId } })),
	});
}

export function useToolApprovalRules(podId: string) {
	return useQuery({
		queryKey: ["tool-approval-rules", podId],
		queryFn: () =>
			unwrap(client.api.pods[":podId"]["tool-approval-rules"].$get({ param: { podId } })),
	});
}

export function useRevokeToolApprovalRule(podId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (ruleId: string) =>
			unwrapEmpty(
				client.api.pods[":podId"]["tool-approval-rules"][":ruleId"].$delete({
					param: { podId, ruleId },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tool-approval-rules", podId] }),
	});
}

export function useConnectionActions(podId: string) {
	const queryClient = useQueryClient();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ["connections", podId] });
	const route = () => client.api.pods[":podId"].connections;

	return {
		create: useMutation({
			mutationFn: (json: NewConnection) => unwrap(route().$post({ param: { podId }, json })),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ connectionId, json }: { connectionId: string; json: ConnectionUpdate }) =>
				unwrap(
					route()[":connectionId"].$patch({
						param: { podId, connectionId },
						json,
					}),
				),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				unwrapEmpty(
					route()[":connectionId"].$delete({
						param: { podId, connectionId },
					}),
				),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				unwrap(
					route()[":connectionId"].test.$post({
						param: { podId, connectionId },
					}),
				),
			onSettled: refresh,
		}),
		/** From the catalog: makes the connection and leaves for its sign-in, as one step. */
		connect: useMutation({
			mutationFn: async (json: { name: string; url: string }) => {
				const result = await unwrap(route().connect.$post({ param: { podId }, json }));
				browser.go(result.authorizationUrl);
				return result;
			},
		}),
		/**
		 * Starts signing a connection in. The browser leaves for the authorization
		 * server and comes back to this page through the API's callback, so
		 * nothing here needs to wait for it.
		 */
		signIn: useMutation({
			mutationFn: async ({ connectionId }: { connectionId: string }) => {
				const result = await unwrap(
					route()[":connectionId"].oauth.start.$post({
						param: { podId, connectionId },
					}),
				);
				// Left here rather than in `onSuccess`, which is skipped once the
				// card that asked has gone from the page.
				if (result.authorizationUrl) browser.go(result.authorizationUrl);
				return result;
			},
			onSuccess: (result) => {
				if (!result.authorizationUrl) void refresh();
			},
		}),
	};
}

/** Leaving the page, behind one seam so a test can watch it. */
export const browser = { go: (url: string) => window.location.assign(url) };
