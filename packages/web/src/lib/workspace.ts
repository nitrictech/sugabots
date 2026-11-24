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
import { failureMessage, NotReadyError } from "@/lib/failure.ts";
import { loadFailure } from "@/lib/query.ts";

/**
 * Which workspace is being looked at, and what the caller may do in it.
 *
 * Under `/$workspace` the address decides. Elsewhere — the landing page and
 * workspace setup — it is the one last chosen, kept in a module-level store because
 * every `useWorkspace` has to agree on it within one render.
 *
 * It is the client's choice and not the server's: every scoped route names its
 * workspace in the path. localStorage is enough to survive a reload, which is
 * all "which one was I in" needs to do.
 */

const KEY = "sugabots-workspace";

/** Every workspace this member belongs to, in the order the API lists them. */
export const workspacesQuery = queryOptions({
	queryKey: ["workspaces"],
	queryFn: ({ signal }) => Effect.runPromise(client.api.workspaces.list(), { signal }),
});

export function useWorkspaces() {
	return useQuery(workspacesQuery);
}

/** The members in a workspace. Asks for nobody's roster until there is a workspace. */
export function useMemberships(workspaceId: string | undefined) {
	return useQuery({
		queryKey: ["workspaces", workspaceId, "memberships"],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.workspaces.memberships({ params: { workspace: workspaceId } }),
						{
							signal,
						},
					)
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
 * another one, or workspace setup when there is none.
 */
export function useDeleteWorkspace() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (workspaceId: string) =>
			Effect.runPromise(client.api.workspaces.delete({ params: { workspace: workspaceId } })),
		onSuccess: async (_, workspaceId) => {
			queries.setQueryData(workspacesQuery.queryKey, (workspaces) =>
				workspaces?.filter((workspace) => workspace.id !== workspaceId),
			);
			await queries.invalidateQueries({ queryKey: workspacesQuery.queryKey });
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

/** The workspace's time zone, and how many automations have routines that would move with it. */
export function useWorkspaceTimeZone(workspaceId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["workspaces", workspaceId, "time-zone"],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.workspaces.timeZone({ params: { workspace: workspaceId } }), {
				signal,
			}),
		enabled,
	});
}

/** Moves the workspace, and the routines in its old zone, to another time zone. */
export function useChangeWorkspaceTimeZone(workspaceId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (timeZone: TimeZone) =>
			Effect.runPromise(
				client.api.workspaces.changeTimeZone({
					params: { workspace: workspaceId },
					payload: { timeZone },
				}),
			),
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["workspaces"] }),
				queries.invalidateQueries({ queryKey: ["automations"] }),
			]),
	});
}

export function useSendInvitation(workspaceId: string) {
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

/** An invitation that did not go out, and why, in words fit for members. */
export interface InvitationFailure {
	email: string;
	reason: string;
}

/**
 * Sends an invitation to each of `emails`, one at a time, with `send`, such
 * as `useSendInvitation`'s `mutateAsync`. One failing does not stop the rest;
 * those that failed are returned, so only they need fixing and sending again.
 */
export async function sendInvitations(
	emails: readonly string[],
	role: AssignableWorkspaceRole,
	send: (invitation: { email: string; role: AssignableWorkspaceRole }) => Promise<unknown>,
): Promise<InvitationFailure[]> {
	const failures: InvitationFailure[] = [];
	for (const email of emails) {
		try {
			await send({ email, role });
		} catch (error) {
			failures.push({ email, reason: failureMessage(error) });
		}
	}
	return failures;
}

/** The invitations still outstanding, which the roster lists beside its members. */
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
 * Leaving makes everything cached stale: every project, bot and chat on
 * screen belonged to a workspace this member is no longer in. So every query is
 * invalidated, and those on screen are fetched again.
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
 * Both invalidate more than the roster: a role decides which projects somebody
 * reaches and what each project's `permissions` say, so when the member changed is
 * the one looking, everything scoped to them is stale. Invalidating on every
 * change rather than working out whether it was you keeps that correct for one
 * refetch nobody will notice.
 */
function useMembershipChange<Input>(
	workspaceId: string,
	change: (input: Input) => Promise<unknown>,
) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: change,
		onSuccess: () =>
			Promise.all([
				queries.invalidateQueries({ queryKey: ["workspaces", workspaceId, "memberships"] }),
				queries.invalidateQueries({ queryKey: ["workspace-standing"] }),
				queries.invalidateQueries({ queryKey: ["projects"] }),
				// Making somebody an administrator or the owner puts them in every project members
				// made. A personal bot's default project, and someone else's Personal Assistant's,
				// are still reached only as their bot is.
				queries.invalidateQueries({ queryKey: ["project-members"] }),
				queries.invalidateQueries({ queryKey: ["project-members"] }),
				queries.invalidateQueries({ queryKey: ["bots"] }),
			]),
	});
}

export function useChangeRole(workspaceId: string) {
	return useMembershipChange(
		workspaceId,
		({ membershipId, role }: { membershipId: string; role: AssignableWorkspaceRole }) =>
			Effect.runPromise(
				client.api.workspaces.changeRole({
					params: { workspace: workspaceId, membershipId },
					payload: { role },
				}),
			),
	);
}

/** Hands the workspace to another member in it. The caller stays on as an administrator. */
export function useHandOverOwnership(workspaceId: string) {
	return useMembershipChange(workspaceId, (membershipId: string) =>
		Effect.runPromise(
			client.api.workspaces.handOverOwnership({
				params: { workspace: workspaceId },
				payload: { membershipId },
			}),
		),
	);
}

export function useRemoveMembership(workspaceId: string) {
	return useMembershipChange(workspaceId, (membershipId: string) =>
		Effect.runPromise(
			client.api.workspaces.removeMembership({ params: { workspace: workspaceId, membershipId } }),
		),
	);
}

/**
 * The id of the workspace being looked at, for a mutation to send. Its getter
 * throws `NotReadyError` while the workspace is still loading, which the
 * mutation then fails with.
 */
export function useRequiredWorkspaceId(): () => string {
	const workspaceId = useWorkspace().workspace?.id;
	return () => {
		if (!workspaceId) throw new NotReadyError();
		return workspaceId;
	};
}

/**
 * The one being looked at: the address's, with no fallback, so a link never
 * opens under another workspace's name. Outside `/$workspace`, whatever was
 * last chosen, and the first otherwise.
 */
export function useWorkspace(): {
	workspace: Workspace | undefined;
	isPending: boolean;
	/** Set when the workspaces could not be loaded; see `loadFailure`. */
	failure: { error: unknown } | undefined;
	refetch: () => Promise<unknown>;
} {
	const workspaces = useWorkspaces();
	const { data, isPending, refetch } = workspaces;
	const chosen = useSyncExternalStore(subscribe, read, read);
	const slug = useParams({ strict: false, select: (params) => params.workspace });

	return {
		workspace:
			slug === undefined
				? (data?.find((one) => one.id === chosen) ?? data?.[0])
				: data?.find((one) => one.slug === slug),
		isPending,
		failure: loadFailure(workspaces),
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
 * and letting the request fail is worse than not drawing it: it teaches members
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
	createProjects: false,
	createBots: false,
	updateWorkspace: false,
	manageProviders: false,
	manageMembers: false,
	chooseSystemModel: false,
	manageUsage: false,
	manageAdmins: false,
	handOverOwnership: false,
	deleteWorkspace: false,
};

/** The caller's role in the workspace being looked at, and what it lets them do there. */
export function useWorkspaceStanding() {
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
