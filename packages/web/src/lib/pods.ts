import type { NewPod, PodUpdate } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
	const workspaceId = workspace.workspace?.id;

	const query = useQuery({
		queryKey: ["pods", workspaceId],
		queryFn: workspaceId
			? () => unwrap(client.api.workspaces[":workspaceId"].pods.$get({ param: { workspaceId } }))
			: skipToken,
	});

	return {
		...query,
		/** Still resolving if we do not even know the workspace yet. */
		isPending: workspace.isPending || query.isPending,
	};
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
			return unwrap(
				client.api.workspaces[":workspaceId"].pods.$post({
					param: { workspaceId },
					json: input,
				}),
			);
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
			return unwrap(
				client.api.workspaces[":workspaceId"]["personal-pod"].$post({
					param: { workspaceId },
					json: { model },
				}),
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
			unwrap(client.api.pods[":podId"].$patch({ param: { podId }, json: input })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
	});
}

export function useDeletePod() {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (podId: string) =>
			unwrapEmpty(client.api.pods[":podId"].$delete({ param: { podId } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pods", workspaceId] }),
	});
}

export function usePodMembers(podId: string) {
	return useQuery({
		queryKey: ["pod-members", podId],
		queryFn: () => unwrap(client.api.pods[":podId"].members.$get({ param: { podId } })),
	});
}

/**
 * Adds a workspace member to a pod, or takes them out. One mutation for both
 * directions because the caller is one list with an add and a remove on it.
 */
export function usePlacePodMember(podId: string) {
	const queries = useQueryClient();

	return useMutation({
		mutationFn: ({ userId, member }: { userId: string; member: boolean }) => {
			const route = client.api.pods[":podId"].members;
			return unwrapEmpty(
				member
					? route.$post({ param: { podId }, json: { userId } })
					: route[":userId"].$delete({ param: { podId, userId } }),
			);
		},
		onSuccess: () => queries.invalidateQueries({ queryKey: ["pod-members", podId] }),
	});
}
