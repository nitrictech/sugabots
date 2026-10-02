import {
	type AssignableWorkspaceRole,
	type TimeZone,
	timeZoneSchema,
	type Workspace,
	type WorkspacePermissions,
	type WorkspaceRole,
} from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { useSyncExternalStore } from "react";
import { client } from "@/api.ts";

/**
 * Which workspace is being looked at, and what the caller may do in it.
 *
 * Under `/$workspace` the address decides. Elsewhere — the landing page and
 * onboarding — it is the one last chosen, kept in a module-level store because
 * every `useWorkspace` has to agree on it within one render.
 *
 * It is the client's choice and not the server's: every scoped route names its
 * workspace in the path. localStorage is enough to survive a reload, which is
 * all "which one was I in" needs to do.
 */

const KEY = "sugabots-workspace";

/** Every workspace this person belongs to, in the order the API lists them. */
export const workspacesQuery = queryOptions({
	queryKey: ["workspaces"],
	queryFn: ({ signal }) => Effect.runPromise(client.api.workspaces.list(), { signal }),
});

export function useWorkspaces() {
	return useQuery(workspacesQuery);
}

/** The people in a workspace. Asks for nobody's roster until there is a workspace. */
export function useWorkspaceMembers(workspaceId: string | undefined) {
	return useQuery({
		queryKey: ["workspaces", workspaceId, "members"],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.workspaces.members({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

export function useCreateWorkspace() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ name, slug }: { name: string; slug: string }) =>
			Effect.runPromise(
				client.api.workspaces.create({ payload: { name, slug, timeZone: browserTimeZone() } }),
			),
		onSuccess: async (workspace) => {
			chooseWorkspace(workspace.id);
			await queries.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}

/**
 * Deletes a workspace for good. It leaves the list at once, so `/` opens
 * another one, or onboarding when there is none.
 */
export function useDeleteWorkspace() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (workspaceId: string) =>
			Effect.runPromise(client.api.workspaces.delete({ params: { workspace: workspaceId } })),
		onSuccess: async (_, workspaceId) => {
			queries.setQueryData<readonly Workspace[]>(["workspaces"], (workspaces) =>
				workspaces?.filter((workspace) => workspace.id !== workspaceId),
			);
			await queries.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}

/**
 * The time zone this browser is set to, which a new workspace takes. Undefined
 * when the API would not accept it, and the workspace is then in the default.
 */
export function browserTimeZone(): TimeZone | undefined {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return Schema.is(timeZoneSchema)(zone) ? zone : undefined;
}

export function useUpdateWorkspace(workspaceId: string | undefined) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ name, slug }: { name: string; slug: string }) => {
			if (!workspaceId) throw new Error("A workspace is required");
			return Effect.runPromise(
				client.api.workspaces.update({
					params: { workspace: workspaceId },
					payload: { name, slug },
				}),
			);
		},
		onSuccess: () => queries.invalidateQueries({ queryKey: ["workspaces"] }),
	});
}

export function useInviteWorkspaceMember(workspaceId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({
			email,
			role,
			resend,
		}: {
			email: string;
			role: AssignableWorkspaceRole;
			resend?: boolean;
		}) =>
			Effect.runPromise(
				client.api.workspaces.invite({
					params: { workspace: workspaceId },
					payload: { email, role, resend },
				}),
			),
		onSuccess: () =>
			queries.invalidateQueries({ queryKey: ["workspaces", workspaceId, "invites"] }),
	});
}

/** The invitations still outstanding, which the roster lists beside its people. */
export function useWorkspaceInvitations(workspaceId: string) {
	return useQuery({
		queryKey: ["workspaces", workspaceId, "invites"],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.workspaces.invitations({ params: { workspace: workspaceId } }), {
				signal,
			}),
	});
}

export function useCancelWorkspaceInvitation(workspaceId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (invitationId: string) =>
			Effect.runPromise(client.api.workspaces.cancelInvitation({ params: { invitationId } })),
		onSuccess: () =>
			queries.invalidateQueries({ queryKey: ["workspaces", workspaceId, "invites"] }),
	});
}

/**
 * Leaving takes the whole client with it: every pod, agent and conversation on
 * screen belonged to a workspace this person is no longer in, so the cache is
 * cleared rather than refetched.
 */
export function useLeaveWorkspace(workspaceId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(client.api.workspaces.leave({ params: { workspace: workspaceId } })),
		onSuccess: async () => {
			await queries.invalidateQueries();
		},
	});
}

/**
 * Changing what somebody may do, and taking them out of the workspace.
 *
 * Both invalidate more than the roster: a role decides which pods somebody
 * reaches and what each pod's `permissions` say, so when the person changed is
 * the one looking, everything scoped to them is stale. Invalidating on every
 * change rather than working out whether it was you keeps that correct for one
 * refetch nobody will notice.
 */
function useMemberChange<Input>(workspaceId: string, change: (input: Input) => Promise<unknown>) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: change,
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["workspaces", workspaceId, "members"] }),
				queries.invalidateQueries({ queryKey: ["workspace-standing"] }),
				queries.invalidateQueries({ queryKey: ["pods"] }),
				// Making somebody an administrator or the owner puts them in every shared pod.
				queries.invalidateQueries({ queryKey: ["pod-members"] }),
				queries.invalidateQueries({ queryKey: ["agents"] }),
			]),
	});
}

export function useUpdateWorkspaceMemberRole(workspaceId: string) {
	return useMemberChange(
		workspaceId,
		({ memberId, role }: { memberId: string; role: AssignableWorkspaceRole }) =>
			Effect.runPromise(
				client.api.workspaces.updateMember({
					params: { workspace: workspaceId, memberId },
					payload: { role },
				}),
			),
	);
}

/** Hands the workspace to another member. The caller stays on as an administrator. */
export function useTransferWorkspaceOwnership(workspaceId: string) {
	return useMemberChange(workspaceId, (memberId: string) =>
		Effect.runPromise(
			client.api.workspaces.transferOwnership({
				params: { workspace: workspaceId },
				payload: { memberId },
			}),
		),
	);
}

export function useRemoveWorkspaceMember(workspaceId: string) {
	return useMemberChange(workspaceId, (memberId: string) =>
		Effect.runPromise(
			client.api.workspaces.removeMember({ params: { workspace: workspaceId, memberId } }),
		),
	);
}

/**
 * The one being looked at: the address's, with no fallback, so a link never
 * opens under another workspace's name. Outside `/$workspace`, whatever was
 * last chosen, and the first otherwise.
 */
export function useWorkspace(): {
	workspace: Workspace | undefined;
	isPending: boolean;
	error: unknown;
	refetch: () => Promise<unknown>;
} {
	const { data, isPending, error, refetch } = useWorkspaces();
	const chosen = useSyncExternalStore(subscribe, read, read);
	const slug = useParams({ strict: false, select: (params) => params.workspace });

	return {
		workspace:
			slug === undefined
				? (data?.find((one) => one.id === chosen) ?? data?.[0])
				: data?.find((one) => one.slug === slug),
		isPending,
		error,
		refetch,
	};
}

/** Switches workspace. Every `useWorkspace` in the tree re-renders. */
export function chooseWorkspace(workspaceId: string): void {
	selectedWorkspaceId = workspaceId;
	try {
		localStorage.setItem(KEY, workspaceId);
		storageWriteFailed = false;
	} catch {
		storageWriteFailed = true;
		// Storage can be off. The choice still holds for this session.
	}
	for (const listener of listeners) {
		listener();
	}
}

/**
 * What the caller may do in the workspace they are looking at, as the API has
 * already decided it.
 *
 * Asked so that a control nobody can use is not *drawn* for them. Drawing it
 * and letting the request fail is worse than not drawing it: it teaches people
 * that things in this app sometimes do not work.
 *
 * Every answer is `false` while it is in flight, so the moment before the
 * answer arrives shows less rather than more.
 */
export function useWorkspacePermissions(): WorkspacePermissions {
	return useWorkspaceStanding().data?.permissions ?? NOTHING_YET;
}

/**
 * Which role the caller holds, for the places that name it, such as the access
 * line in settings. Anything that gates on what somebody may *do* asks
 * `useWorkspacePermissions`.
 */
export function useWorkspaceRole(): WorkspaceRole | undefined {
	return useWorkspaceStanding().data?.role;
}

const NOTHING_YET: WorkspacePermissions = {
	createPods: false,
	manageProviders: false,
	manageMembers: false,
	configureBuiltInAgents: false,
	manageUsage: false,
	manageAdmins: false,
	transferOwnership: false,
	deleteWorkspace: false,
};

function useWorkspaceStanding() {
	const workspaceId = useWorkspace().workspace?.id;

	return useQuery({
		queryKey: ["workspace-standing", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.workspaceAccess({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

const listeners = new Set<() => void>();
let selectedWorkspaceId = storedWorkspaceId();
let storageWriteFailed = false;

function subscribe(listener: () => void): () => void {
	if (!storageWriteFailed) {
		selectedWorkspaceId = storedWorkspaceId();
	}
	listeners.add(listener);
	function syncStorage(event: StorageEvent) {
		if (event.key !== KEY && event.key !== null) return;
		storageWriteFailed = false;
		selectedWorkspaceId = event.key === KEY ? event.newValue : storedWorkspaceId();
		listener();
	}
	window.addEventListener("storage", syncStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", syncStorage);
	};
}

function read(): string | null {
	return selectedWorkspaceId;
}

function storedWorkspaceId(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}
