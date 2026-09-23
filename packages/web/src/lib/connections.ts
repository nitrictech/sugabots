import type { ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

export function useConnections(podId: string) {
	return useQuery({
		queryKey: ["connections", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.connections.list({ params: { podId } }), { signal }),
	});
}

export function useToolApprovalRules(podId: string) {
	return useQuery({
		queryKey: ["tool-approval-rules", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.toolApprovals.listRules({ params: { podId } }), { signal }),
	});
}

export function useRevokeToolApprovalRule(podId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (ruleId: string) =>
			Effect.runPromise(client.api.toolApprovals.revokeRule({ params: { podId, ruleId } })),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tool-approval-rules", podId] }),
	});
}

export function useConnectionActions(podId: string) {
	const queryClient = useQueryClient();
	const refresh = () => queryClient.invalidateQueries({ queryKey: ["connections", podId] });
	const { connections } = client.api;

	return {
		create: useMutation({
			mutationFn: (json: NewConnection) =>
				Effect.runPromise(connections.create({ params: { podId }, payload: json })),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ connectionId, json }: { connectionId: string; json: ConnectionUpdate }) =>
				Effect.runPromise(connections.update({ params: { podId, connectionId }, payload: json })),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				Effect.runPromise(connections.remove({ params: { podId, connectionId } })),
			onSuccess: refresh,
		}),
		test: useMutation({
			mutationFn: ({ connectionId }: { connectionId: string }) =>
				Effect.runPromise(connections.test({ params: { podId, connectionId } })),
			onSettled: refresh,
		}),
		/** From the catalog: makes the connection and leaves for its sign-in, as one step. */
		connect: useMutation({
			mutationFn: async (json: { name: string; url: string }) => {
				const result = await Effect.runPromise(
					connections.connectFromCatalog({ params: { podId }, payload: json }),
				);
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
				const result = await Effect.runPromise(
					connections.startOAuth({ params: { podId, connectionId } }),
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
