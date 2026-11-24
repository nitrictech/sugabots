export * as Membership from "./membership.ts";

import {
	type AssignableWorkspaceRole,
	INVITATION_LIFETIME_DAYS,
	type InvitationPreview,
	type Membership,
	type NewWorkspace,
	type NewWorkspaceInvitation,
	type Workspace,
	type WorkspaceDetails,
	type WorkspaceInvitation,
	type WorkspacePermissions,
	type WorkspaceRole,
} from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
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
import type { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import {
	afterCommit,
	query,
	queryCatching,
	serviceOperations,
	transaction,
} from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { bot, invitation, member, membership, workspace } from "../../database/schema.ts";
import { Email } from "../../email/email.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import { MemberSignIns } from "../../providers/member-sign-ins.ts";
import { offeredModels } from "../../providers/model-providers/model-provider-reads.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { SearchProviderStore } from "../../providers/search-providers/search-provider-store.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { invitationPath } from "../../server-settings/web-app-paths.ts";
import type { UserFacing } from "../../user-message.ts";
import { BotStore } from "../bots/bot-store.ts";
import { PersonalAssistants } from "../bots/personal-assistants.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";

/**
 * The workspaces the current actor is in, and who else is. Every operation
 * checks what the actor may do itself; anything they may not know about is
 * `ResourceHidden`.
 */
export interface Interface {
	/** In the order they joined them. */
	readonly workspaces: Effect.Effect<readonly Workspace[], never, CurrentActor.Service>;
	/** Owned by the member who created it. */
	readonly create: (input: {
		details: NewWorkspace;
	}) => Effect.Effect<
		Workspace,
		SlugTaken | SlugShapedLikeUuid | TimeZoneUnknown,
		CurrentActor.Service
	>;
	/**
	 * Its projects, bots, chats and providers go with it, and its members
	 * lose it. What its models cost stays on the ledger. The owner's alone.
	 * Its projects' computers are destroyed first, since their records go with
	 * it: when a provider can't be reached, or a computer is made meanwhile,
	 * the workspace is kept, to try again.
	 */
	readonly delete: (
		input: InWorkspace,
	) => Effect.Effect<
		void,
		AuthorizationDenied | Computers.Unavailable | ProjectComputers.ComputerMadeMeanwhile,
		CurrentActor.Service
	>;
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
	readonly memberships: (
		input: InWorkspace,
	) => Effect.Effect<readonly Membership[], AuthorizationDenied, CurrentActor.Service>;
	/** Making or unmaking an administrator is the owner's alone. The owner's own role is fixed. */
	readonly changeRole: (
		input: InWorkspace & { membershipId: string; role: AssignableWorkspaceRole },
	) => Effect.Effect<void, AuthorizationDenied | OwnerStays, CurrentActor.Service>;
	/**
	 * Their Personal Assistant, pins and project memberships go with them, and so
	 * does what signs in as them (see `MemberSignIns`). Only the owner removes an
	 * administrator, and nobody removes the owner. Nobody is removed while a
	 * model provider signs in with their subscription.
	 */
	readonly remove: (
		input: InWorkspace & { membershipId: string },
	) => Effect.Effect<
		void,
		| AuthorizationDenied
		| OwnerStays
		| MemberSignIns.SubscriptionInUse
		| Computers.Unavailable
		| ProjectComputers.ComputerMadeMeanwhile,
		CurrentActor.Service
	>;
	/**
	 * What signs in as them goes with them, as when they are removed. The owner
	 * stays until they have handed ownership over, and anybody stays while a
	 * model provider signs in with their subscription.
	 */
	readonly leave: (
		input: InWorkspace,
	) => Effect.Effect<
		void,
		| AuthorizationDenied
		| OwnerStays
		| MemberSignIns.SubscriptionInUse
		| Computers.Unavailable
		| ProjectComputers.ComputerMadeMeanwhile,
		CurrentActor.Service
	>;
	/**
	 * Makes the membership's member the workspace's owner, and the owner an administrator,
	 * together. Handing it to the owner changes nothing.
	 */
	readonly handOverOwnership: (
		input: InWorkspace & { membershipId: string },
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	/** The invitations still waiting to be accepted. */
	readonly invitations: (
		input: InWorkspace,
	) => Effect.Effect<readonly WorkspaceInvitation[], AuthorizationDenied, CurrentActor.Service>;
	readonly invite: (
		input: InWorkspace & { invitation: NewWorkspaceInvitation },
	) => Effect.Effect<
		WorkspaceInvitation,
		AuthorizationDenied | AlreadyInWorkspace | AlreadyInvited,
		CurrentActor.Service
	>;
	readonly cancelInvitation: (
		input: ForInvitation,
	) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * For the member the invitation was sent to: one still to accept, or one
	 * they have accepted and whose workspace they are still in.
	 */
	readonly invitation: (
		input: ForInvitation,
	) => Effect.Effect<InvitationPreview, ResourceHidden | NotTheInvitee, CurrentActor.Service>;
	/**
	 * Lets the invitee in, with their Personal Assistant. Accepting again, as a
	 * second tab or a reload does, answers with the workspace and changes
	 * nothing.
	 */
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

interface ForInvitation {
	invitationId: string;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Membership") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Membership");
	const authorization = yield* Authorization.Service;
	const accounts = yield* Accounts.Service;
	const email = yield* Email.Service;
	const serverSettings = yield* ServerSettings.Service;
	const sender = yield* Email.transactionalSender;
	const personalAssistants = yield* PersonalAssistants.Service;
	const bots = yield* BotStore.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const memberSignIns = yield* MemberSignIns.Service;

	/**
	 * Removes the membership, which cascades to their Personal Assistant, pins
	 * and project memberships, and forgets what signs in as them, unless a
	 * model provider signs in with their subscription. That is checked first,
	 * so a refusal leaves everything as it was. Their assistant's computer is
	 * destroyed next: its record is the only way to find the machine, so when
	 * the provider can't be reached, or a computer is made meanwhile, the
	 * membership stays, to try again.
	 */
	const deleteMembership = (removed: { id: string; workspaceId: string; memberId: string }) =>
		Effect.gen(function* () {
			yield* memberSignIns.forget({ workspaceId: removed.workspaceId, memberId: removed.memberId });
			const [assistant] = yield* query((db) =>
				db
					.select({ id: bot.id })
					.from(bot)
					.where(
						and(eq(bot.workspaceId, removed.workspaceId), eq(bot.assistantOf, removed.memberId)),
					)
					.limit(1),
			);
			if (assistant) {
				const assistantProject = {
					workspaceId: removed.workspaceId,
					projectId: yield* defaultProjectOf(assistant.id),
				};
				yield* projectComputers.destroy(assistantProject);
				yield* ProjectComputers.lockWithoutComputer(assistantProject);
			}
			yield* query((db) => db.delete(membership).where(eq(membership.id, removed.id)));
		});
	const searchProviders = yield* SearchProviderStore.Service;
	const modelProviders = yield* ModelProviderStore.Service;
	const ids = yield* Ids.Service;

	/**
	 * Runs `use` in a transaction holding the workspace's membership lock (see
	 * `lockWorkspace`), with the caller's standing read once the lock is
	 * held. A change that held the lock first has committed by then, so an
	 * owner who has just handed ownership on is decided as the administrator
	 * they now are, and somebody just removed is hidden.
	 */
	const underMembershipLock = <A, E, R>(
		workspaceRef: string,
		permission: WorkspacePermission,
		use: (standing: WorkspaceStanding) => Effect.Effect<A, E, R>,
	) =>
		transaction(
			Effect.gen(function* () {
				const { workspaceId } = yield* authorization.workspace(workspaceRef, permission);
				yield* lockWorkspace(workspaceId);
				return yield* use(yield* authorization.workspace(workspaceId, permission));
			}),
		);

	/**
	 * The Personal Assistant of somebody joining, on the workspace's
	 * default model, or on another the workspace offers while it does not offer
	 * that one.
	 */
	const provisionJoining = (workspaceId: string, memberId: string) =>
		Effect.gen(function* () {
			const { models, defaultModel } = yield* offeredModels(workspaceId);
			// The default goes unoffered while a failed test has its provider off.
			const model = models.some((offered) => offered.modelId === defaultModel)
				? defaultModel
				: models[0]?.modelId;
			if (!model) return yield* personalAssistants.provision({ workspaceId, memberId });
			return yield* personalAssistants.provisionWithModel({ workspaceId, memberId, model }).pipe(
				// Switched off since it was read: start on none, as while the workspace offers none.
				Effect.catchTag("ModelNotEnabled", () =>
					personalAssistants.provision({ workspaceId, memberId }),
				),
			);
		});

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
						inviterName: member.name,
						inviterEmail: member.email,
					})
					.from(workspace)
					.innerJoin(member, eq(member.id, inviterId))
					.where(eq(workspace.id, workspaceId)),
			);
			if (!details) return yield* Effect.die(new Error("The invitation's workspace is missing"));
			const link = `${serverSettings.webAppUrl}${invitationPath(invitationId)}`;
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
			Effect.flatMap(CurrentActor.Service, ({ memberId }) =>
				query((db) =>
					db
						.select(workspaceColumns)
						.from(membership)
						.innerJoin(workspace, eq(workspace.id, membership.workspaceId))
						.where(eq(membership.memberId, memberId))
						.orderBy(asc(membership.createdAt)),
				),
			).pipe(Effect.map((rows) => rows.map(workspaceView))),
		),

		create: (input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
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
								db.insert(membership).values({ workspaceId: created.id, memberId, role: "owner" }),
							);
							yield* bots.createSystemBots({ workspaceId: created.id, createdById: memberId });
							yield* searchProviders.provisionDefault(created.id, memberId);
							yield* modelProviders.seedBuiltInProviders(created.id);
							yield* personalAssistants.provision({ workspaceId: created.id, memberId });
							return workspaceView(created);
						}),
					);
				}),
			),

		delete: (input) =>
			operation(
				"delete",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(
						input.workspace,
						"workspace.delete",
					);
					// Computers are destroyed outside any transaction, so no lock waits
					// on a provider and each destroyed computer's record is forgotten for
					// good, letting a retry resume. The caller is authorized again under
					// the membership lock before the delete, so an owner who hands
					// ownership on meanwhile no longer deletes the workspace. The new
					// owner keeps it, with its computers destroyed; projects remake
					// theirs when next used.
					yield* projectComputers.destroyAllIn(workspaceId);
					yield* underMembershipLock(workspaceId, "workspace.delete", () =>
						Effect.gen(function* () {
							yield* ProjectComputers.lockWorkspaceWithoutComputers(workspaceId);
							yield* query((db) => db.delete(workspace).where(eq(workspace.id, workspaceId)));
						}),
					);
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
					return workspaceView(updated);
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

		memberships: (input) =>
			operation(
				"memberships",
				Effect.gen(function* () {
					const standing = yield* authorization.workspace(input.workspace, "workspace.read");
					const rows = yield* query((db) =>
						db
							.select({
								id: membership.id,
								role: membership.role,
								member: {
									id: member.id,
									email: member.email,
									name: member.name,
									image: member.image,
								},
								joinedAt: membership.createdAt,
							})
							.from(membership)
							.innerJoin(member, eq(member.id, membership.memberId))
							.where(eq(membership.workspaceId, standing.workspaceId))
							.orderBy(asc(membership.createdAt)),
					);
					return rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
				}),
			),

		changeRole: (input) =>
			operation(
				"changeRole",
				underMembershipLock(input.workspace, "workspace.members.manage", (standing) =>
					Effect.gen(function* () {
						const target = yield* membershipIn(standing.workspaceId, input.membershipId);
						if (target.role === "owner") return yield* new OwnerStays();
						if (target.role === "admin" || input.role === "admin") {
							yield* requireWorkspacePermission(standing, "workspace.admins.manage");
						}
						// Promoting puts them in every project members made, by the
						// `administrator_projects` trigger; demoting leaves their projects as they are.
						yield* query((db) =>
							db.update(membership).set({ role: input.role }).where(eq(membership.id, target.id)),
						);
					}),
				),
			),

		remove: (input) =>
			operation(
				"remove",
				underMembershipLock(input.workspace, "workspace.members.manage", (standing) =>
					Effect.gen(function* () {
						const target = yield* membershipIn(standing.workspaceId, input.membershipId);
						if (target.role === "owner") return yield* new OwnerStays();
						if (target.role === "admin") {
							yield* requireWorkspacePermission(standing, "workspace.admins.manage");
						}
						yield* deleteMembership({ ...target, workspaceId: standing.workspaceId });
					}),
				),
			),

		leave: (input) =>
			operation(
				"leave",
				underMembershipLock(input.workspace, "workspace.read", (standing) =>
					Effect.gen(function* () {
						const { memberId } = standing.actor;
						const [own] = yield* query((db) =>
							db
								.select({ id: membership.id, role: membership.role })
								.from(membership)
								.where(
									and(
										eq(membership.workspaceId, standing.workspaceId),
										eq(membership.memberId, memberId),
									),
								),
						);
						if (!own) return yield* new ResourceHidden({ resource: "workspace" });
						if (own.role === "owner") return yield* new OwnerStays();
						yield* deleteMembership({ id: own.id, workspaceId: standing.workspaceId, memberId });
					}),
				),
			),

		handOverOwnership: (input) =>
			operation(
				"handOverOwnership",
				underMembershipLock(input.workspace, "workspace.ownership.handOver", (standing) =>
					Effect.gen(function* () {
						const target = yield* membershipIn(standing.workspaceId, input.membershipId);
						if (target.role === "owner") return;
						// The owner steps down first: `membership_owner_idx` allows
						// one owner, and would refuse the new one while the old one stands.
						// The new owner joins every project members made by the
						// `administrator_projects` trigger, as an admin would.
						yield* query((db) =>
							db
								.update(membership)
								.set({ role: "admin" })
								.where(
									and(
										eq(membership.workspaceId, standing.workspaceId),
										eq(membership.role, "owner"),
									),
								),
						);
						yield* query((db) =>
							db.update(membership).set({ role: "owner" }).where(eq(membership.id, target.id)),
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
								id: invitation.id,
								email: invitation.email,
								role: invitation.role,
								expiresAt: invitation.expiresAt,
							})
							.from(invitation)
							.where(
								and(
									eq(invitation.workspaceId, standing.workspaceId),
									eq(invitation.status, "pending"),
								),
							)
							.orderBy(asc(invitation.createdAt)),
					);
					return rows.map(invitationView);
				}),
			),

		invite: (input) =>
			operation(
				"invite",
				underMembershipLock(input.workspace, "workspace.members.manage", (standing) =>
					Effect.gen(function* () {
						if (input.invitation.role === "admin") {
							yield* requireWorkspacePermission(standing, "workspace.admins.manage");
						}
						const workspaceId = standing.workspaceId;
						const inviterId = standing.actor.memberId;
						const address = input.invitation.email.toLowerCase();
						const [existing] = yield* query((db) =>
							db
								.select({ id: membership.id })
								.from(membership)
								.innerJoin(member, eq(member.id, membership.memberId))
								.where(
									and(
										eq(membership.workspaceId, workspaceId),
										eq(sql`lower(${member.email})`, address),
									),
								),
						);
						if (existing) return yield* new AlreadyInWorkspace();

						const now = yield* DateTime.now;
						const expiresAt = DateTime.toDate(
							DateTime.add(now, { milliseconds: Duration.toMillis(INVITATION_LIFETIME) }),
						);
						const [outstanding] = yield* query((db) =>
							db
								.select({ id: invitation.id })
								.from(invitation)
								.where(
									and(
										eq(invitation.workspaceId, workspaceId),
										eq(invitation.email, address),
										eq(invitation.status, "pending"),
										gt(invitation.expiresAt, DateTime.toDate(now)),
									),
								),
						);
						if (outstanding && !input.invitation.resend) return yield* new AlreadyInvited();

						const [row] = outstanding
							? yield* query((db) =>
									db
										.update(invitation)
										.set({ role: input.invitation.role, expiresAt, inviterId })
										.where(eq(invitation.id, outstanding.id))
										.returning(),
								)
							: yield* Effect.flatMap(
									// The id is the invitation link, so random v4 rather than the
									// partly guessable time-ordered v7 default.
									ids.random,
									(id) =>
										query((db) =>
											db
												.insert(invitation)
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
					const [pending] = yield* query((db) =>
						db
							.select({ workspaceId: invitation.workspaceId })
							.from(invitation)
							.where(and(eq(invitation.id, input.invitationId), eq(invitation.status, "pending"))),
					);
					if (!pending) return yield* hidden;
					// A workspace the actor is not in is hidden, so an invitation to it
					// is answered exactly as one that does not exist.
					yield* authorization
						.workspace(pending.workspaceId, "workspace.members.manage")
						.pipe(Effect.catchTag("ResourceHidden", () => Effect.fail(hidden)));
					yield* query((db) =>
						db
							.update(invitation)
							.set({ status: "canceled" })
							.where(eq(invitation.id, input.invitationId)),
					);
				}),
			),

		invitation: (input) =>
			operation(
				"invitation",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const found = yield* invitationFor(memberId, input.invitationId);
					if (found.status === "accepted") return found;
					return {
						status: "pending" as const,
						workspaceName: found.workspaceName,
						inviterName: found.inviterName,
						role: found.role,
					};
				}),
			),

		accept: (input) =>
			operation(
				"accept",
				transaction(
					Effect.gen(function* () {
						const { memberId } = yield* CurrentActor.Service;
						const found = yield* invitationFor(memberId, input.invitationId);
						if (found.status === "accepted") return { workspaceId: found.workspaceId };
						if (accounts.requireEmailVerification && !found.inviteeVerified) {
							return yield* new EmailUnverified();
						}
						yield* query((db) =>
							Effect.gen(function* () {
								yield* db
									.insert(membership)
									.values({
										workspaceId: found.workspaceId,
										memberId,
										role: found.role,
									})
									.onConflictDoNothing();
								yield* db
									.update(invitation)
									.set({ status: "accepted" })
									.where(eq(invitation.id, input.invitationId));
							}),
						);
						yield* provisionJoining(found.workspaceId, memberId);
						return { workspaceId: found.workspaceId };
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		PersonalAssistants.layer,
		BotStore.layer,
		SearchProviderStore.layer,
		ModelProviderStore.layer,
		ProjectComputers.layer,
		MemberSignIns.layer,
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
		return userText`The owner stays until they hand ownership over to somebody else`;
	}
}

export class AlreadyInWorkspace
	extends Data.TaggedError("AlreadyInWorkspace")
	implements UserFacing
{
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

/** The columns of a workspace the API describes, for `workspaceView`. */
const workspaceColumns = {
	id: workspace.id,
	name: workspace.name,
	slug: workspace.slug,
	timeZone: workspace.timeZone,
	setUpAt: workspace.setUpAt,
};

function workspaceView(row: Omit<Workspace, "setUpAt"> & { setUpAt: Date | null }): Workspace {
	return { ...row, setUpAt: row.setUpAt?.toISOString() ?? null };
}

const INVITATION_LIFETIME = Duration.days(INVITATION_LIFETIME_DAYS);

function requireSlugUnlikeUuid(slug: string) {
	return isUuid(slug) ? Effect.fail(new SlugShapedLikeUuid()) : Effect.void;
}

export function requireTimeZoneKnownToPostgres(timeZone: string) {
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

/**
 * Serialises membership changes with each other and with deleting the
 * workspace, so handing over ownership cannot cross another change to the
 * same members. The lock lets rows that refer to the workspace still be added,
 * so its chats, runs, projects and bots aren't held up while a membership's
 * removal waits on their Personal Assistant's computer at its provider.
 */
function lockWorkspace(workspaceId: string) {
	return query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.where(eq(workspace.id, workspaceId))
			.for("no key update"),
	);
}

function membershipIn(workspaceId: string, membershipId: string) {
	return Effect.flatMap(
		query((db) =>
			db
				.select({
					id: membership.id,
					role: membership.role,
					memberId: membership.memberId,
				})
				.from(membership)
				.where(and(eq(membership.id, membershipId), eq(membership.workspaceId, workspaceId))),
		),
		([found]) =>
			found ? Effect.succeed(found) : Effect.fail(new ResourceHidden({ resource: "membership" })),
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

/**
 * The invitation `invitationId`, locked for an enclosing transaction, when
 * `memberId` is the member it was sent to: pending and unexpired, or accepted
 * while they are still in its workspace, so its link leads back in. Anything
 * else is hidden, so a link cannot be probed, and leaving a workspace ends
 * what its link can do.
 */
function invitationFor(memberId: string, invitationId: string) {
	return Effect.gen(function* () {
		const now = yield* DateTime.nowAsDate;
		const [found] = yield* query((db) =>
			db
				.select({
					status: invitation.status,
					stillIn: membership.id,
					workspaceId: invitation.workspaceId,
					email: invitation.email,
					role: invitation.role,
					workspaceName: workspace.name,
					inviterName: member.name,
				})
				.from(invitation)
				.innerJoin(workspace, eq(workspace.id, invitation.workspaceId))
				.innerJoin(member, eq(member.id, invitation.inviterId))
				.leftJoin(
					membership,
					and(
						eq(membership.workspaceId, invitation.workspaceId),
						eq(membership.memberId, memberId),
					),
				)
				.where(
					and(
						eq(invitation.id, invitationId),
						or(
							and(eq(invitation.status, "pending"), gt(invitation.expiresAt, now)),
							eq(invitation.status, "accepted"),
						),
					),
				)
				.for("update", { of: invitation }),
		);
		const hidden = new ResourceHidden({ resource: "invitation" });
		if (!found) return yield* hidden;
		if (found.status === "accepted" && found.stillIn === null) return yield* hidden;
		const [invitee] = yield* query((db) =>
			db
				.select({ email: member.email, emailVerified: member.emailVerified })
				.from(member)
				.where(eq(member.id, memberId)),
		);
		if (invitee?.email.toLowerCase() !== found.email) return yield* new NotTheInvitee();
		if (found.status === "accepted") {
			return { status: "accepted" as const, workspaceId: found.workspaceId };
		}
		return {
			status: "pending" as const,
			workspaceId: found.workspaceId,
			role: found.role,
			workspaceName: found.workspaceName,
			inviterName: found.inviterName,
			inviteeVerified: invitee.emailVerified,
		};
	});
}

function invitationView(row: {
	id: string;
	email: string;
	role: AssignableWorkspaceRole;
	expiresAt: Date;
}): WorkspaceInvitation {
	// Every send sets the expiry one lifetime ahead, so the last send is one lifetime before it.
	const sentAt = DateTime.subtractDuration(DateTime.makeUnsafe(row.expiresAt), INVITATION_LIFETIME);
	return {
		id: row.id,
		email: row.email,
		role: row.role,
		expiresAt: row.expiresAt.toISOString(),
		sentAt: DateTime.formatIso(sentAt),
	};
}
