export * as Membership from "./membership.ts";

import type {
	AssignableWorkspaceRole,
	InvitationPreview,
	NewWorkspace,
	NewWorkspaceInvitation,
	Workspace,
	WorkspaceDetails,
	WorkspaceInvitation,
	WorkspaceMember,
	WorkspacePermissions,
	WorkspaceRole,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Context, Data, DateTime, Duration, Effect, Layer } from "effect";
import { Accounts } from "../../accounts/accounts.ts";
import {
	ActionForbidden,
	type AuthorizationDenied,
	ResourceHidden,
	type WorkspaceStanding,
} from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import {
	mayInWorkspace,
	type WorkspacePermission,
	workspacePermissions,
} from "../../authorization/permissions.ts";
import {
	afterCommit,
	query,
	queryCatching,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { user, workspace, workspaceInvite, workspaceMember } from "../../database/schema.ts";
import { Email } from "../../email/email.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import { Installation } from "../../installation/installation.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { SearchProviderRepository } from "../../providers/search-providers/search-provider-repository.ts";
import type { UserFacing } from "../../user-message.ts";
import { AgentRepository } from "../agents/agent-repository.ts";
import { PersonalPods } from "../pods/personal-pods.ts";

/**
 * The workspaces the current actor is in, and who else is. Every operation
 * checks what the actor may do itself; anything they may not know about is
 * `ResourceHidden`.
 */
export interface Interface {
	/** In the order they joined them. */
	readonly workspaces: Effect.Effect<readonly Workspace[], never, CurrentActor.Service>;
	/** Owned by the person who created it. */
	readonly create: (input: {
		details: NewWorkspace;
	}) => Effect.Effect<
		Workspace,
		SlugTaken | SlugShapedLikeUuid | TimeZoneUnknown,
		CurrentActor.Service
	>;
	/**
	 * Its pods, bots, conversations and providers go with it, and its members
	 * lose it. What its models cost stays on the ledger. The owner's alone.
	 */
	readonly delete: (
		input: InWorkspace,
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	readonly update: (
		input: InWorkspace & { details: WorkspaceDetails },
	) => Effect.Effect<
		Workspace,
		AuthorizationDenied | SlugTaken | SlugShapedLikeUuid,
		CurrentActor.Service
	>;
	/** The actor's role in the workspace and what it lets them do there. */
	readonly access: (
		input: InWorkspace,
	) => Effect.Effect<
		{ role: WorkspaceRole; permissions: WorkspacePermissions },
		AuthorizationDenied,
		CurrentActor.Service
	>;
	readonly members: (
		input: InWorkspace,
	) => Effect.Effect<readonly WorkspaceMember[], AuthorizationDenied, CurrentActor.Service>;
	/** Making or unmaking an administrator is the owner's alone. The owner's own role is fixed. */
	readonly changeRole: (
		input: InWorkspace & { memberId: string; role: AssignableWorkspaceRole },
	) => Effect.Effect<void, AuthorizationDenied | OwnerStays, CurrentActor.Service>;
	/**
	 * Their Personal pod and pod memberships go with them. Only the owner
	 * removes an administrator, and nobody removes the owner.
	 */
	readonly remove: (
		input: InWorkspace & { memberId: string },
	) => Effect.Effect<void, AuthorizationDenied | OwnerStays, CurrentActor.Service>;
	/** The owner stays until they have transferred ownership. */
	readonly leave: (
		input: InWorkspace,
	) => Effect.Effect<void, AuthorizationDenied | OwnerStays, CurrentActor.Service>;
	/**
	 * Makes the member the workspace's owner, and the owner an administrator,
	 * together. Handing it to the owner changes nothing.
	 */
	readonly transferOwnership: (
		input: InWorkspace & { memberId: string },
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	/** The invitations still waiting to be accepted. */
	readonly invitations: (
		input: InWorkspace,
	) => Effect.Effect<readonly WorkspaceInvitation[], AuthorizationDenied, CurrentActor.Service>;
	readonly invite: (
		input: InWorkspace & { invitation: NewWorkspaceInvitation },
	) => Effect.Effect<
		WorkspaceInvitation,
		AuthorizationDenied | AlreadyMember | AlreadyInvited,
		CurrentActor.Service
	>;
	readonly cancelInvitation: (
		input: ForInvitation,
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	/** For the person the invitation was sent to. */
	readonly invitation: (
		input: ForInvitation,
	) => Effect.Effect<InvitationPreview, ResourceHidden | NotTheInvitee, CurrentActor.Service>;
	readonly accept: (
		input: ForInvitation,
	) => Effect.Effect<
		{ workspaceId: string },
		ResourceHidden | NotTheInvitee | EmailUnverified,
		CurrentActor.Service
	>;
}

/** `workspace` is the workspace's id or slug. */
export interface InWorkspace {
	workspace: string;
}

export interface ForInvitation {
	invitationId: string;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Membership") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Membership");
	const authorization = yield* Authorization.Service;
	const accounts = yield* Accounts.Service;
	const email = yield* Email.Service;
	const installation = yield* Installation.Service;
	const sender = yield* Email.transactionalSender;
	const personalPods = yield* PersonalPods.Service;
	const agents = yield* AgentRepository.Service;
	const searchProviders = yield* SearchProviderRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;
	const ids = yield* Ids.Service;

	const sendInvitation = (
		invitationId: string,
		to: string,
		workspaceId: string,
		inviterId: string,
	) =>
		Effect.gen(function* () {
			const [details] = yield* query((db) =>
				db
					.select({
						workspaceName: workspace.name,
						inviterName: user.name,
						inviterEmail: user.email,
					})
					.from(workspace)
					.innerJoin(user, eq(user.id, inviterId))
					.where(eq(workspace.id, workspaceId)),
			);
			if (!details) return yield* Effect.die(new Error("The invitation's workspace is missing"));
			const link = `${installation.webAppUrl}/invite/${encodeURIComponent(invitationId)}`;
			yield* afterCommit(
				Effect.orDie(
					email.send({
						from: sender,
						to: [{ email: to }],
						replyTo: { email: details.inviterEmail, name: details.inviterName },
						subject: `${details.inviterName} invited you to ${details.workspaceName} on Sugabots`,
						text: `${details.inviterName} (${details.inviterEmail}) invited you to join the ${details.workspaceName} workspace.\n\nAccept: ${link}`,
					}),
				),
			);
		});

	return Service.of({
		workspaces: operation(
			"workspaces",
			Effect.flatMap(CurrentActor.Service, ({ userId }) =>
				query((db) =>
					db
						.select(workspaceColumns)
						.from(workspaceMember)
						.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
						.where(eq(workspaceMember.userId, userId))
						.orderBy(asc(workspaceMember.createdAt)),
				),
			),
		),

		create: (input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					yield* requireSlugUnlikeUuid(input.details.slug);
					if (input.details.timeZone !== undefined) {
						yield* requireTimeZoneKnownToPostgres(input.details.timeZone);
					}
					return yield* transaction(
						Effect.gen(function* () {
							const [created] = yield* queryCatching(
								(db) => db.insert(workspace).values(input.details).returning(workspaceColumns),
								(failure) => (isUniqueViolation(failure) ? new SlugTaken() : undefined),
							);
							if (!created) return yield* Effect.die(new Error("The workspace was not created"));
							yield* query((db) =>
								db
									.insert(workspaceMember)
									.values({ workspaceId: created.id, userId, role: "owner" }),
							);
							yield* agents.ensureSystemAgents({ workspaceId: created.id, createdById: userId });
							yield* searchProviders.provisionDefault(created.id, userId);
							yield* modelProviders.seedPresets(created.id);
							yield* personalPods.provision({ workspaceId: created.id, userId });
							return created;
						}),
					);
				}),
			),

		delete: (input) =>
			operation(
				"delete",
				Effect.gen(function* () {
					const standing = yield* authorization.workspace(input.workspace, "workspace.delete");
					yield* query((db) => db.delete(workspace).where(eq(workspace.id, standing.workspaceId)));
				}),
			),

		update: (input) =>
			operation(
				"update",
				Effect.gen(function* () {
					const standing = yield* authorization.workspace(input.workspace, "workspace.update");
					yield* requireSlugUnlikeUuid(input.details.slug);
					const [updated] = yield* queryCatching(
						(db) =>
							db
								.update(workspace)
								.set(input.details)
								.where(eq(workspace.id, standing.workspaceId))
								.returning(workspaceColumns),
						(failure) => (isUniqueViolation(failure) ? new SlugTaken() : undefined),
					);
					if (!updated) return yield* new ResourceHidden({ resource: "workspace" });
					return updated;
				}),
			),

		access: (input) =>
			operation(
				"access",
				Effect.map(authorization.workspace(input.workspace, "workspace.read"), ({ actor }) => ({
					role: actor.workspaceRole,
					permissions: workspacePermissions(actor),
				})),
			),

		members: (input) =>
			operation(
				"members",
				Effect.gen(function* () {
					const standing = yield* authorization.workspace(input.workspace, "workspace.read");
					const rows = yield* query((db) =>
						db
							.select({
								id: workspaceMember.id,
								role: workspaceMember.role,
								user: { id: user.id, email: user.email, name: user.name, image: user.image },
								joinedAt: workspaceMember.createdAt,
							})
							.from(workspaceMember)
							.innerJoin(user, eq(user.id, workspaceMember.userId))
							.where(eq(workspaceMember.workspaceId, standing.workspaceId))
							.orderBy(asc(workspaceMember.createdAt)),
					);
					return rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
				}),
			),

		changeRole: (input) =>
			operation(
				"changeRole",
				transaction(
					Effect.gen(function* () {
						const standing = yield* authorization.workspace(
							input.workspace,
							"workspace.members.manage",
						);
						yield* lockWorkspace(standing.workspaceId);
						const target = yield* memberIn(standing.workspaceId, input.memberId);
						if (target.role === "owner") return yield* new OwnerStays();
						if (target.role === "admin" || input.role === "admin") {
							yield* requireWorkspacePermission(standing, "workspace.admins.manage");
						}
						// Promoting puts them in every shared pod, by the
						// `administrator_shared_pods` trigger; demoting leaves their pods as they are.
						yield* query((db) =>
							db
								.update(workspaceMember)
								.set({ role: input.role })
								.where(eq(workspaceMember.id, target.id)),
						);
					}),
				),
			),

		remove: (input) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						const standing = yield* authorization.workspace(
							input.workspace,
							"workspace.members.manage",
						);
						yield* lockWorkspace(standing.workspaceId);
						const target = yield* memberIn(standing.workspaceId, input.memberId);
						if (target.role === "owner") return yield* new OwnerStays();
						if (target.role === "admin") {
							yield* requireWorkspacePermission(standing, "workspace.admins.manage");
						}
						yield* deleteMember(target.id);
					}),
				),
			),

		leave: (input) =>
			operation(
				"leave",
				transaction(
					Effect.gen(function* () {
						const standing = yield* authorization.workspace(input.workspace, "workspace.read");
						yield* lockWorkspace(standing.workspaceId);
						const { userId } = standing.actor;
						const [own] = yield* query((db) =>
							db
								.select({ id: workspaceMember.id, role: workspaceMember.role })
								.from(workspaceMember)
								.where(
									and(
										eq(workspaceMember.workspaceId, standing.workspaceId),
										eq(workspaceMember.userId, userId),
									),
								),
						);
						if (!own) return yield* new ResourceHidden({ resource: "workspace" });
						if (own.role === "owner") return yield* new OwnerStays();
						yield* deleteMember(own.id);
					}),
				),
			),

		transferOwnership: (input) =>
			operation(
				"transferOwnership",
				transaction(
					Effect.gen(function* () {
						const standing = yield* authorization.workspace(
							input.workspace,
							"workspace.ownership.transfer",
						);
						yield* lockWorkspace(standing.workspaceId);
						const target = yield* memberIn(standing.workspaceId, input.memberId);
						if (target.role === "owner") return;
						// The owner steps down first: `workspace_member_owner_idx` allows
						// one owner, and would refuse the new one while the old one stands.
						// The new owner joins every shared pod by the
						// `administrator_shared_pods` trigger, as an admin would.
						yield* query((db) =>
							db
								.update(workspaceMember)
								.set({ role: "admin" })
								.where(
									and(
										eq(workspaceMember.workspaceId, standing.workspaceId),
										eq(workspaceMember.role, "owner"),
									),
								),
						);
						yield* query((db) =>
							db
								.update(workspaceMember)
								.set({ role: "owner" })
								.where(eq(workspaceMember.id, target.id)),
						);
					}),
				),
			),

		invitations: (input) =>
			operation(
				"invitations",
				Effect.gen(function* () {
					const standing = yield* authorization.workspace(input.workspace, "workspace.read");
					const rows = yield* query((db) =>
						db
							.select({
								id: workspaceInvite.id,
								email: workspaceInvite.email,
								role: workspaceInvite.role,
								expiresAt: workspaceInvite.expiresAt,
							})
							.from(workspaceInvite)
							.where(
								and(
									eq(workspaceInvite.workspaceId, standing.workspaceId),
									eq(workspaceInvite.status, "pending"),
								),
							)
							.orderBy(asc(workspaceInvite.createdAt)),
					);
					return rows.map(invitationView);
				}),
			),

		invite: (input) =>
			operation(
				"invite",
				transaction(
					Effect.gen(function* () {
						const standing = yield* authorization.workspace(
							input.workspace,
							"workspace.members.manage",
						);
						if (input.invitation.role === "admin") {
							yield* requireWorkspacePermission(standing, "workspace.admins.manage");
						}
						const workspaceId = standing.workspaceId;
						const inviterId = standing.actor.userId;
						const address = input.invitation.email.toLowerCase();
						yield* lockWorkspace(workspaceId);
						const [member] = yield* query((db) =>
							db
								.select({ id: workspaceMember.id })
								.from(workspaceMember)
								.innerJoin(user, eq(user.id, workspaceMember.userId))
								.where(
									and(
										eq(workspaceMember.workspaceId, workspaceId),
										eq(sql`lower(${user.email})`, address),
									),
								),
						);
						if (member) return yield* new AlreadyMember();

						const now = yield* DateTime.now;
						const expiresAt = DateTime.toDate(
							DateTime.add(now, { milliseconds: Duration.toMillis(INVITATION_LIFETIME) }),
						);
						const [outstanding] = yield* query((db) =>
							db
								.select({ id: workspaceInvite.id })
								.from(workspaceInvite)
								.where(
									and(
										eq(workspaceInvite.workspaceId, workspaceId),
										eq(workspaceInvite.email, address),
										eq(workspaceInvite.status, "pending"),
										gt(workspaceInvite.expiresAt, DateTime.toDate(now)),
									),
								),
						);
						if (outstanding && !input.invitation.resend) return yield* new AlreadyInvited();

						const [row] = outstanding
							? yield* query((db) =>
									db
										.update(workspaceInvite)
										.set({ role: input.invitation.role, expiresAt, inviterId })
										.where(eq(workspaceInvite.id, outstanding.id))
										.returning(),
								)
							: yield* Effect.flatMap(
									// The id is the invitation link, so random v4 rather than the
									// partly guessable time-ordered v7 default.
									ids.random,
									(id) =>
										query((db) =>
											db
												.insert(workspaceInvite)
												.values({
													id,
													workspaceId,
													email: address,
													role: input.invitation.role,
													inviterId,
													expiresAt,
												})
												.returning(),
										),
								);
						if (!row) return yield* Effect.die(new Error("The invitation was not saved"));
						yield* sendInvitation(row.id, address, workspaceId, inviterId);
						return invitationView(row);
					}),
				),
			),

		cancelInvitation: (input) =>
			operation(
				"cancelInvitation",
				Effect.gen(function* () {
					const hidden = new ResourceHidden({ resource: "invitation" });
					if (!isUuid(input.invitationId)) return yield* hidden;
					const [invitation] = yield* query((db) =>
						db
							.select({ workspaceId: workspaceInvite.workspaceId })
							.from(workspaceInvite)
							.where(
								and(
									eq(workspaceInvite.id, input.invitationId),
									eq(workspaceInvite.status, "pending"),
								),
							),
					);
					if (!invitation) return yield* hidden;
					// A workspace the actor is not in is hidden, so an invitation to it
					// is answered exactly as one that does not exist.
					yield* authorization
						.workspace(invitation.workspaceId, "workspace.members.manage")
						.pipe(Effect.catchTag("ResourceHidden", () => Effect.fail(hidden)));
					yield* query((db) =>
						db
							.update(workspaceInvite)
							.set({ status: "canceled" })
							.where(eq(workspaceInvite.id, input.invitationId)),
					);
				}),
			),

		invitation: (input) =>
			operation(
				"invitation",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const invitation = yield* invitationFor(userId, input.invitationId);
					return { workspaceName: invitation.workspaceName, inviterName: invitation.inviterName };
				}),
			),

		accept: (input) =>
			operation(
				"accept",
				transaction(
					Effect.gen(function* () {
						const { userId } = yield* CurrentActor.Service;
						const invitation = yield* invitationFor(userId, input.invitationId);
						if (accounts.requireEmailVerification && !invitation.inviteeVerified) {
							return yield* new EmailUnverified();
						}
						yield* query((db) =>
							Effect.gen(function* () {
								yield* db
									.insert(workspaceMember)
									.values({
										workspaceId: invitation.workspaceId,
										userId,
										role: invitation.role,
									})
									.onConflictDoNothing();
								yield* db
									.update(workspaceInvite)
									.set({ status: "accepted" })
									.where(eq(workspaceInvite.id, input.invitationId));
							}),
						);
						yield* personalPods.provision({ workspaceId: invitation.workspaceId, userId });
						return { workspaceId: invitation.workspaceId };
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		PersonalPods.layer,
		AgentRepository.layer,
		SearchProviderRepository.layer,
		ModelProviderRepository.layer,
	]),
);

export class SlugTaken extends Data.TaggedError("SlugTaken") implements UserFacing {
	get userMessage() {
		return userText`That address is taken by another workspace`;
	}
}

/** The API reads a UUID-shaped workspace reference as an id, so such a slug would be unreachable. */
export class SlugShapedLikeUuid
	extends Data.TaggedError("SlugShapedLikeUuid")
	implements UserFacing
{
	get userMessage() {
		return userText`A workspace address cannot be shaped like a UUID`;
	}
}

/**
 * Postgres does not have the time zone, though the API's own check passed:
 * their time zone databases can differ. Every day and month in the workspace
 * is worked out in Postgres, so it has to know the zone.
 */
export class TimeZoneUnknown extends Data.TaggedError("TimeZoneUnknown") implements UserFacing {
	get userMessage() {
		return userText`That time zone isn't one the server knows`;
	}
}

/** The owner cannot be demoted, removed or leave: ownership has to be handed on first. */
export class OwnerStays extends Data.TaggedError("OwnerStays") implements UserFacing {
	get userMessage() {
		return userText`The owner stays until they transfer ownership to somebody else`;
	}
}

export class AlreadyMember extends Data.TaggedError("AlreadyMember") implements UserFacing {
	get userMessage() {
		return userText`They are already in this workspace`;
	}
}

export class AlreadyInvited extends Data.TaggedError("AlreadyInvited") implements UserFacing {
	get userMessage() {
		return userText`They have already been invited`;
	}
}

export class NotTheInvitee extends Data.TaggedError("NotTheInvitee") implements UserFacing {
	get userMessage() {
		return userText`This invitation was sent to a different address`;
	}
}

export class EmailUnverified extends Data.TaggedError("EmailUnverified") implements UserFacing {
	get userMessage() {
		return userText`Verify your email address before accepting this invitation`;
	}
}

/** A workspace as the API describes it. */
const workspaceColumns = {
	id: workspace.id,
	name: workspace.name,
	slug: workspace.slug,
	timeZone: workspace.timeZone,
};

const INVITATION_LIFETIME = Duration.days(2);

function requireSlugUnlikeUuid(slug: string) {
	return isUuid(slug) ? Effect.fail(new SlugShapedLikeUuid()) : Effect.void;
}

function requireTimeZoneKnownToPostgres(timeZone: string) {
	return query((db) =>
		db
			.select({ name: sql<string>`name` })
			.from(sql`pg_timezone_names`)
			.where(sql`name = ${timeZone}`),
	).pipe(
		Effect.flatMap((known) =>
			known.length > 0 ? Effect.void : Effect.fail(new TimeZoneUnknown()),
		),
	);
}

/** Serialises membership changes, so a transfer of ownership cannot cross another change to the same people. */
function lockWorkspace(workspaceId: string) {
	return query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.where(eq(workspace.id, workspaceId))
			.for("update"),
	);
}

function memberIn(workspaceId: string, memberId: string) {
	return Effect.flatMap(
		query((db) =>
			db
				.select({ id: workspaceMember.id, role: workspaceMember.role })
				.from(workspaceMember)
				.where(and(eq(workspaceMember.id, memberId), eq(workspaceMember.workspaceId, workspaceId))),
		),
		([member]) =>
			member ? Effect.succeed(member) : Effect.fail(new ResourceHidden({ resource: "member" })),
	);
}

/**
 * A further permission the caller must hold for this change, beyond the one
 * `authorization.workspace` already checked, decided from the same standing.
 */
function requireWorkspacePermission(standing: WorkspaceStanding, permission: WorkspacePermission) {
	return mayInWorkspace(standing.actor, permission)
		? Effect.void
		: Effect.fail(new ActionForbidden({ permission }));
}

/** Cascades to the Personal pod and pod memberships. */
function deleteMember(memberId: string) {
	return query((db) => db.delete(workspaceMember).where(eq(workspaceMember.id, memberId)));
}

/**
 * A pending, unexpired invitation, locked for an enclosing transaction, when
 * `userId` is the person it was sent to. Anything else is hidden, so a link
 * cannot be probed.
 */
function invitationFor(userId: string, invitationId: string) {
	return Effect.gen(function* () {
		const now = yield* DateTime.nowAsDate;
		const [invitation] = yield* query((db) =>
			db
				.select({
					workspaceId: workspaceInvite.workspaceId,
					email: workspaceInvite.email,
					role: workspaceInvite.role,
					workspaceName: workspace.name,
					inviterName: user.name,
				})
				.from(workspaceInvite)
				.innerJoin(workspace, eq(workspace.id, workspaceInvite.workspaceId))
				.innerJoin(user, eq(user.id, workspaceInvite.inviterId))
				.where(
					and(
						eq(workspaceInvite.id, invitationId),
						eq(workspaceInvite.status, "pending"),
						gt(workspaceInvite.expiresAt, now),
					),
				)
				.for("update", { of: workspaceInvite }),
		);
		if (!invitation) return yield* new ResourceHidden({ resource: "invitation" });
		const [invitee] = yield* query((db) =>
			db
				.select({ email: user.email, emailVerified: user.emailVerified })
				.from(user)
				.where(eq(user.id, userId)),
		);
		if (invitee?.email.toLowerCase() !== invitation.email) return yield* new NotTheInvitee();
		return { ...invitation, inviteeVerified: invitee.emailVerified };
	});
}

function invitationView(row: {
	id: string;
	email: string;
	role: AssignableWorkspaceRole;
	expiresAt: Date;
}): WorkspaceInvitation {
	return { id: row.id, email: row.email, role: row.role, expiresAt: row.expiresAt.toISOString() };
}
