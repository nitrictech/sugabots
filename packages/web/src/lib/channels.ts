import type { Channel, ChannelUpdate, NewChannel } from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The channels this person sees: those they are in, which for an
 * administrator is every one, and the public ones they could join
 * (`isMember` tells them apart). Each one carries what they may do in it, as
 * the API resolves it.
 *
 * The sidebar, the directory and the routes share this one query rather than
 * fetching twice: a route resolves its `:channel` slug out of the same cached
 * list, which is also why there is no by-slug endpoint.
 */
export function useChannels() {
	const workspace = useWorkspace();
	const query = useQuery(channelsQuery(workspace.workspace?.id));

	return {
		...query,
		/** Still resolving if we do not even know the workspace yet. */
		isPending: workspace.isPending || query.isPending,
	};
}

/** The channels of one workspace, which need not be the one being looked at. */
function channelsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["channels", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.channels.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

export function findChannel(
	channels: readonly Channel[] | undefined,
	slug: string,
): Channel | undefined {
	return channels?.find((channel) => channel.slug === slug);
}

/**
 * Makes a channel, and puts it in the sidebar.
 *
 * The API adds the creator as a member in the same transaction, so the new
 * channel is visible to whoever made it — which is why invalidating the list
 * is enough and there is nothing to reconcile by hand.
 */
export function useCreateChannel() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: NewChannel) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return Effect.runPromise(
				client.api.channels.create({ params: { workspace: workspaceId }, payload: input }),
			);
		},
		onSuccess: () => queries.invalidateQueries({ queryKey: ["channels", workspaceId] }),
	});
}

export function useUpdateChannel(channelId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: ChannelUpdate) =>
			Effect.runPromise(client.api.channels.update({ params: { channelId }, payload: input })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["channels", workspaceId] }),
	});
}

export function useDeleteChannel() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (channelId: string) =>
			Effect.runPromise(client.api.channels.remove({ params: { channelId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["channels", workspaceId] }),
	});
}

/** Who is in the channel; nothing is asked while `channelId` is undefined. */
export function useChannelMembers(channelId: string | undefined) {
	return useQuery({
		queryKey: ["channel-members", channelId],
		queryFn: channelId
			? ({ signal }) =>
					Effect.runPromise(client.api.channels.listMembers({ params: { channelId } }), { signal })
			: skipToken,
	});
}

/**
 * Adds a workspace member to a channel, or takes them out. One mutation for both
 * directions because the caller is one list with an add and a remove on it.
 */
export function usePlaceChannelMember(channelId: string) {
	const queries = useQueryClient();

	return useMutation({
		mutationFn: ({ userId, member }: { userId: string; member: boolean }) =>
			Effect.runPromise(
				member
					? client.api.channels.addMember({ params: { channelId }, payload: { userId } })
					: client.api.channels.removeMember({ params: { channelId, userId } }),
			),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["channel-members", channelId] }),
	});
}

/** Takes you out of a channel, and so out of the sidebar. */
export function useLeaveChannel(channelId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: () => Effect.runPromise(client.api.channels.leave({ params: { channelId } })),
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["channels", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["channel-members", channelId] }),
			]),
	});
}

/** Puts you in a public channel, and so in the sidebar. */
export function useJoinChannel() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (channelId: string) =>
			Effect.runPromise(client.api.channels.join({ params: { channelId } })),
		onSuccess: (_joined, channelId) =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["channels", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["channel-members", channelId] }),
			]),
	});
}

/** The bots added to the channel; nothing is asked while `channelId` is undefined. */
export function useChannelBots(channelId: string | undefined) {
	return useQuery({
		queryKey: ["channel-bots", channelId],
		queryFn: channelId
			? ({ signal }) =>
					Effect.runPromise(client.api.channels.listBots({ params: { channelId } }), { signal })
			: skipToken,
	});
}

/** Adds a public bot to the channel, or takes one out. */
export function usePlaceChannelBot(channelId: string) {
	const queries = useQueryClient();

	return useMutation({
		mutationFn: ({ botId, added }: { botId: string; added: boolean }) =>
			Effect.runPromise(
				added
					? client.api.channels.addBot({ params: { channelId }, payload: { botId } })
					: client.api.channels.removeBot({ params: { channelId, botId } }),
			),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["channel-bots", channelId] }),
	});
}
