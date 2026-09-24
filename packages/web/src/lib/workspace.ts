import type { WorkspacePermissions, WorkspaceRole } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import { client } from "@/api.ts";

/**
 * Which workspace is being looked at, and what the caller may do in it.
 *
 * The choice is a module-level store rather than a provider or per-component
 * state, because four different places ask for it — the top bar's switcher, the
 * sidebar's roster, the pod list and the role check — and they have to agree
 * within one render. `useSyncExternalStore` is what makes that one value rather
 * than four copies of it.
 *
 * It is the client's choice and not the server's. better-auth keeps an
 * `activeOrganizationId` on the session row, but nothing in our API reads it —
 * every scoped route names its workspace in the path — so writing it would be
 * state with no reader. localStorage is enough to survive a reload, which is
 * all "which one was I in" needs to do.
 */

type Workspace = Awaited<ReturnType<typeof client.auth.workspaces.list>>[number];

const KEY = "sugabots-workspace";

/** Every workspace this person belongs to, in the order the API lists them. */
export function useWorkspaces() {
	return useQuery({
		queryKey: ["workspaces"],
		queryFn: () => client.auth.workspaces.list(),
	});
}

/** The people in a workspace. Asks for nobody's roster until there is a workspace. */
export function useWorkspaceMembers(workspaceId: string | undefined) {
	return useQuery({
		queryKey: ["workspaces", workspaceId, "members"],
		queryFn: workspaceId ? () => client.auth.workspaces.members(workspaceId) : skipToken,
	});
}

export function useCreateWorkspace() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ name, slug }: { name: string; slug: string }) =>
			client.auth.workspaces.create({ name, slug }),
		onSuccess: async (workspace) => {
			chooseWorkspace(workspace.id);
			await queries.invalidateQueries({ queryKey: ["workspaces"] });
		},
	});
}

export function useUpdateWorkspace(workspaceId: string | undefined) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ name, slug }: { name: string; slug: string }) => {
			if (!workspaceId) throw new Error("A workspace is required");
			return client.auth.workspaces.update({ workspaceId, name, slug });
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
			role: WorkspaceRole;
			resend?: boolean;
		}) => client.auth.workspaces.invite({ email, role, workspaceId, resend }),
		onSuccess: () =>
			queries.invalidateQueries({ queryKey: ["workspaces", workspaceId, "invites"] }),
	});
}

/** The invitations still outstanding, which the roster lists beside its people. */
export function useWorkspaceInvitations(workspaceId: string) {
	return useQuery({
		queryKey: ["workspaces", workspaceId, "invites"],
		queryFn: () => client.auth.workspaces.invitations(workspaceId),
	});
}

export function useCancelWorkspaceInvitation(workspaceId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (invitationId: string) => client.auth.workspaces.cancelInvite(invitationId),
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
		mutationFn: () => client.auth.workspaces.leave(workspaceId),
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
				queries.invalidateQueries({ queryKey: ["agents"] }),
			]),
	});
}

export function useUpdateWorkspaceMemberRole(workspaceId: string) {
	return useMemberChange(
		workspaceId,
		({ memberId, role }: { memberId: string; role: WorkspaceRole }) =>
			client.auth.workspaces.updateRole({ workspaceId, memberId, role }),
	);
}

export function useRemoveWorkspaceMember(workspaceId: string) {
	return useMemberChange(workspaceId, (memberId: string) =>
		client.auth.workspaces.removeMember({ workspaceId, memberId }),
	);
}

/**
 * The one being looked at: whatever was last chosen, and the first otherwise —
 * including when the chosen one has gone, which is what a stale id means.
 */
export function useWorkspace(): {
	workspace: Workspace | undefined;
	isPending: boolean;
	error: unknown;
	refetch: () => Promise<unknown>;
} {
	const { data, isPending, error, refetch } = useWorkspaces();
	const chosen = useSyncExternalStore(subscribe, read, read);

	return {
		workspace: data?.find((one) => one.id === chosen) ?? data?.[0],
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
 * Which role the caller holds, for the places that name it: the access line in
 * settings, and the roster controls better-auth decides for itself. Anything
 * that gates on what somebody may *do* asks `useWorkspacePermissions`.
 */
export function useWorkspaceRole(): WorkspaceRole | undefined {
	return useWorkspaceStanding().data?.role;
}

const NOTHING_YET: WorkspacePermissions = {
	createPods: false,
	manageProviders: false,
	manageMembers: false,
	configureBuiltInAgents: false,
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
