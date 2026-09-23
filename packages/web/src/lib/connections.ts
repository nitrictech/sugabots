import type { ConnectionUpdate, NewConnection } from "@sugabots/contracts";
import { connectionPresetFor, hueFromText } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "@/api.ts";

export function useConnections(podId: string) {
	return useQuery({
		queryKey: ["connections", podId],
		queryFn: () => unwrap(client.api.pods[":podId"].connections.$get({ param: { podId } })),
	});
}

/** How a connection is named and marked wherever its tools are shown. */
export interface ConnectionLook {
	name: string;
	/** The catalog entry its logo comes from, when it came from one. */
	presetId?: string;
	hue: number;
}

/**
 * The pod's connections by the handle that prefixes their tool keys, so a
 * `sentry__search_issues` in a transcript can be shown as Sentry's. A handle
 * missing from the map belongs to a connection that has since been removed;
 * callers write the handle out rather than dropping the step.
 */
export function useConnectionLooks(podId: string): ReadonlyMap<string, ConnectionLook> {
	const connections = useConnections(podId);
	const found = connections.data;
	return useMemo(() => {
		const looks = new Map<string, ConnectionLook>();
		for (const connection of found ?? []) {
			const preset = connectionPresetFor(connection.url);
			looks.set(connection.handle, {
				name: connection.name,
				presetId: preset?.id,
				hue: preset?.hue ?? hueFromText(connection.name),
			});
		}
		return looks;
	}, [found]);
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
