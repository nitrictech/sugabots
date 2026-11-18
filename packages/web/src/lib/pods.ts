import type { NewPod, Pod, PodUpdate } from "@sugabots/contracts";
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
export function usePods() {
	const workspace = useWorkspace();
	const query = useQuery(podsQuery(workspace.workspace?.id));

	return {
		...query,
		/** Still resolving if we do not even know the workspace yet. */
		isPending: workspace.isPending || query.isPending,
	};
}

/** The channels of one workspace, which need not be the one being looked at. */
export function podsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["pods", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.pods.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

export function findPod(pods: readonly Pod[] | undefined, slug: string): Pod | undefined {
	return pods?.find((pod) => pod.slug === slug);
}

/**
 * Makes a channel, and puts it in the sidebar.
 *
 * The API adds the creator as a member in the same transaction, so the new
 * channel is visible to whoever made it — which is why invalidating the list
 * is enough and there is nothing to reconcile by hand.
 */
export function useCreatePod() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: NewPod) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return Effect.runPromise(
				client.api.pods.create({ params: { workspace: workspaceId }, payload: input }),
			);
		},
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
	});
}

export function useUpdatePod(podId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: PodUpdate) =>
			Effect.runPromise(client.api.pods.update({ params: { podId }, payload: input })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
	});
}

export function useDeletePod() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (podId: string) => Effect.runPromise(client.api.pods.remove({ params: { podId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
	});
}

/** Who is in the channel; nothing is asked while `podId` is undefined. */
export function usePodMembers(podId: string | undefined) {
	return useQuery({
		queryKey: ["pod-members", podId],
		queryFn: podId
			? ({ signal }) =>
					Effect.runPromise(client.api.pods.listMembers({ params: { podId } }), { signal })
			: skipToken,
	});
}

/**
 * Adds a workspace member to a channel, or takes them out. One mutation for both
 * directions because the caller is one list with an add and a remove on it.
 */
export function usePlacePodMember(podId: string) {
	const queries = useQueryClient();

	return useMutation({
		mutationFn: ({ userId, member }: { userId: string; member: boolean }) =>
			Effect.runPromise(
				member
					? client.api.pods.addMember({ params: { podId }, payload: { userId } })
					: client.api.pods.removeMember({ params: { podId, userId } }),
			),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pod-members", podId] }),
	});
}

/** Takes you out of a channel, and so out of the sidebar. */
export function useLeavePod(podId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: () => Effect.runPromise(client.api.pods.leave({ params: { podId } })),
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["pod-members", podId] }),
			]),
	});
}

/** Puts you in a public channel, and so in the sidebar. */
export function useJoinPod() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (podId: string) => Effect.runPromise(client.api.pods.join({ params: { podId } })),
		onSuccess: (_joined, podId) =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["pod-members", podId] }),
			]),
	});
}

/** The bots added to the channel; nothing is asked while `podId` is undefined. */
export function usePodBots(podId: string | undefined) {
	return useQuery({
		queryKey: ["pod-bots", podId],
		queryFn: podId
			? ({ signal }) =>
					Effect.runPromise(client.api.pods.listBots({ params: { podId } }), { signal })
			: skipToken,
	});
}

/** Adds a public bot to the channel, or takes one out. */
export function usePlacePodBot(podId: string) {
	const queries = useQueryClient();

	return useMutation({
		mutationFn: ({ agentId, added }: { agentId: string; added: boolean }) =>
			Effect.runPromise(
				added
					? client.api.pods.addBot({ params: { podId }, payload: { agentId } })
					: client.api.pods.removeBot({ params: { podId, agentId } }),
			),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pod-bots", podId] }),
	});
}
