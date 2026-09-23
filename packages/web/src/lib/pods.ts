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
 * The pods this person reaches: the shared pods they have joined, every shared
 * pod if they administer the workspace, and their own Personal pod. Each one
 * carries what they may do in it. See `docs/permissions.md`.
 *
 * The sidebar and the routes share this one query rather than fetching twice:
 * the sidebar lists them and a route resolves its `:pod` slug out of the
 * same cached list, which is also why there is no by-slug endpoint.
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

/** The pods query, for a route loader to fill before its page renders. */
export function podsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["pods", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.pods.list({ params: { workspaceId } }), { signal })
			: skipToken,
	});
}

/** The pod an address names by its slug, which is unique within the workspace. */
export function findPod(pods: readonly Pod[] | undefined, slug: string): Pod | undefined {
	return pods?.find((pod) => pod.slug === slug);
}

/**
 * Makes a pod, and puts it in the rail.
 *
 * The API adds the creator as a member in the same transaction, so the new
 * pod is visible to whoever made it — which is why invalidating the list is
 * enough and there is nothing to reconcile by hand.
 */
export function useCreatePod() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: NewPod) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return Effect.runPromise(client.api.pods.create({ params: { workspaceId }, payload: input }));
		},
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
	});
}

export function useEnsurePersonalPod() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (model: string) => {
			if (!workspaceId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.pods.ensurePersonal({ params: { workspaceId }, payload: { model } }),
			);
		},
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
				queries.invalidateQueries({ queryKey: ["agents", workspaceId] }),
			]),
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

export function usePodMembers(podId: string) {
	return useQuery({
		queryKey: ["pod-members", podId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.pods.listMembers({ params: { podId } }), { signal }),
	});
}

/**
 * Adds a workspace member to a pod, or takes them out. One mutation for both
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
