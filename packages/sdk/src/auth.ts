import { apiErrorCodeForStatus, type WorkspaceRole } from "@sugabots/contracts";
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { defaultAc, defaultRoles } from "better-auth/plugins/organization/access";
import { ApiError } from "./errors.ts";
import type { TokenStore } from "./tokens.ts";

/**
 * Accounts, sessions, workspaces and invitations.
 *
 * better-auth serves these routes and ships the client that calls them, so we
 * use it rather than hand-writing another HTTP layer. What we do own is the
 * vocabulary: better-auth calls a tenant an organisation, and everywhere else
 * in this product it is a workspace. The wrapper below is that rename, plus one
 * other thing — better-auth returns `{ data, error }` where the rest of this
 * client throws `ApiError`, and callers should not have to know which half of
 * the API they are talking to.
 */

/**
 * The roles this client can name, which have to be the ones the server
 * registers (`packages/server/src/auth/auth.ts`). Neither package depends on
 * the other, so the two are kept in step by `satisfies`: a role added to
 * `WORKSPACE_ROLES` stops both files compiling until it is registered in both.
 */
const WORKSPACE_ROLE_DEFINITIONS = {
	admin: defaultRoles.admin,
	member: defaultRoles.member,
	viewer: defaultAc.newRole({}),
} satisfies Record<WorkspaceRole, unknown>;

export interface AuthClientOptions {
	baseUrl: string;
	tokens?: TokenStore;
	fetch?: typeof globalThis.fetch;
	/** Overrides the declared origin outside the browser. See below. */
	origin?: string;
}

export function createAuthApi({ baseUrl, tokens, fetch, origin }: AuthClientOptions) {
	// better-auth's `basePath` is ignored whenever `baseURL` already carries a
	// path, and `baseUrl` carries the API's mount path, so /auth goes in the URL.
	const auth = createAuthClient({
		baseURL: `${baseUrl}/auth`,
		plugins: [organizationClient({ roles: WORKSPACE_ROLE_DEFINITIONS })],
		fetchOptions: {
			...(fetch ? { customFetchImpl: fetch } : {}),
			credentials: tokens ? "omit" : "include",
			headers: declaredOrigin(baseUrl, origin),
			...(tokens
				? {
						auth: { type: "Bearer" as const, token: () => tokens.get() },
						onSuccess: (context: { response: Response }) => {
							const issued = context.response.headers.get("set-auth-token");
							if (issued) {
								tokens.set(issued);
							}
						},
					}
				: {}),
		},
	});

	return {
		signUp: (input: { name: string; email: string; password: string; callbackURL?: string }) =>
			orThrow(auth.signUp.email(input)),

		signIn: (input: { email: string; password: string }) => orThrow(auth.signIn.email(input)),

		async signOut(): Promise<void> {
			try {
				await orThrow(auth.signOut());
			} finally {
				// Whether or not the server accepted it, this client is done
				// with the token; keeping it would only fail every next request.
				tokens?.set(undefined);
			}
		},

		workspaces: {
			list: () => orThrow(auth.organization.list()),

			members: (workspaceId: string) =>
				orThrow(auth.organization.listMembers({ query: { organizationId: workspaceId } })).then(
					({ members }) => members,
				),

			create: (input: { name: string; slug: string }) => orThrow(auth.organization.create(input)),

			update: (input: { workspaceId: string; name: string; slug: string }) =>
				orThrow(
					auth.organization.update({
						organizationId: input.workspaceId,
						data: { name: input.name, slug: input.slug },
					}),
				),

			/** The invitations still waiting to be accepted. */
			invitations: (workspaceId: string) =>
				orThrow(auth.organization.listInvitations({ query: { organizationId: workspaceId } })).then(
					(invitations) => invitations.filter(({ status }) => status === "pending"),
				),

			/** Withdraws an invitation, so its link stops working. */
			cancelInvite: (invitationId: string) =>
				inOurWords(orThrow(auth.organization.cancelInvitation({ invitationId }))),

			/** Leaves a workspace. Refused to the last administrator. */
			leave: (workspaceId: string) =>
				inOurWords(orThrow(auth.organization.leave({ organizationId: workspaceId }))),

			/** `memberId` is the membership row's id, which `members` returns. */
			updateRole: (input: { workspaceId: string; memberId: string; role: WorkspaceRole }) =>
				inOurWords(
					orThrow(
						auth.organization.updateMemberRole({
							organizationId: input.workspaceId,
							memberId: input.memberId,
							role: input.role,
						}),
					),
				),

			/** Takes somebody out of the workspace, and their Personal pod with them. */
			removeMember: (input: { workspaceId: string; memberId: string }) =>
				inOurWords(
					orThrow(
						auth.organization.removeMember({
							organizationId: input.workspaceId,
							memberIdOrEmail: input.memberId,
						}),
					),
				),

			/** `resend` refreshes an invitation that is already outstanding. */
			invite: (input: {
				email: string;
				role?: WorkspaceRole;
				workspaceId: string;
				resend?: boolean;
			}) =>
				inOurWords(
					orThrow(
						auth.organization.inviteMember({
							email: input.email,
							role: input.role ?? "member",
							organizationId: input.workspaceId,
							...(input.resend ? { resend: true } : {}),
						}),
					),
				),

			/** Read an invitation before signing in, to show who invited whom. */
			invitation: (id: string) => orThrow(auth.organization.getInvitation({ query: { id } })),

			acceptInvite: (id: string) =>
				orThrow(auth.organization.acceptInvitation({ invitationId: id })),
		},
	};
}

export type AuthApi = ReturnType<typeof createAuthApi>;

/**
 * better-auth refuses a sign-in that arrives without an `Origin` it trusts,
 * which is what stops a page on another site from posting a form at it. A
 * browser sets that header itself and will not let us touch it. Nothing else
 * sets it at all, so Electron, React Native and scripts have to say who they
 * are, and the honest answer is the API's own origin: they are not a web page.
 *
 * Sending it only outside the browser keeps the protection where it matters —
 * a caller that can set headers freely was never the thing being defended
 * against.
 */
function declaredOrigin(baseUrl: string, override?: string): Record<string, string> {
	if (typeof window !== "undefined") {
		return {};
	}
	return { origin: override ?? new URL(baseUrl).origin };
}

interface Failure {
	status?: number;
	statusText?: string;
	message?: string;
	code?: string;
}

/**
 * better-auth's refusals in this product's words.
 *
 * It says "organization" and "owner"; here they are a workspace and an
 * administrator, and its creator role is `admin`. The renaming this module
 * exists for has to reach the failures too — the moment somebody is told they
 * cannot do something is the worst moment for the vocabulary to slip. Keyed by
 * better-auth's own error code, which `orThrow` keeps as `details`; anything
 * not listed is passed through as it came.
 */
const REPHRASED: Record<string, string> = {
	YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
		"A workspace needs at least one administrator",
	YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER:
		"A workspace needs at least one administrator",
	YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER:
		"Only an administrator can change what somebody may do",
	YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: "Only an administrator can remove somebody",
};

async function inOurWords<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (failure) {
		if (!(failure instanceof ApiError) || typeof failure.details !== "string") {
			throw failure;
		}
		const rephrased = REPHRASED[failure.details];
		if (!rephrased) {
			throw failure;
		}
		throw new ApiError(failure.code, rephrased, failure.status, failure.details);
	}
}

/** better-auth answers with `{ data, error }`; this client throws instead. */
async function orThrow<T>(
	call: PromiseLike<{ data: T | null; error: Failure | null }>,
): Promise<T> {
	const { data, error } = await call;

	if (error) {
		const status = error.status ?? 500;
		throw new ApiError(
			apiErrorCodeForStatus(status),
			error.message ?? error.statusText ?? `Request failed with status ${status}`,
			status,
			error.code,
		);
	}
	if (data === null) {
		throw new ApiError("internal", "The auth service returned no data", 500);
	}

	return data;
}

/**
 * Whether better-auth refused because this account has not proved its address.
 *
 * It answers 403 to refusals that have nothing else in common — an invitation
 * addressed to somebody else, a sign-up an invite-only installation will not
 * admit, an unproven address — so the status cannot tell them apart and only
 * its `code` can, which is why `orThrow` keeps it. The vocabulary stays here,
 * so a screen asks the question in its own terms.
 */
export function isEmailUnverified(failure: unknown): boolean {
	return (
		failure instanceof ApiError &&
		typeof failure.details === "string" &&
		emailUnverifiedCodes.has(failure.details)
	);
}

const emailUnverifiedCodes = new Set([
	"EMAIL_NOT_VERIFIED",
	"EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION",
	"EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
]);
