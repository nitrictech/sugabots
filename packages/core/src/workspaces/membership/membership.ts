export * as Membership from "./membership.ts";

import {
	type AssignableWorkspaceRole,
	INVITATION_LIFETIME_DAYS,
	type InvitationPreview,
	type Membership,
	type NewWorkspace,
	type NewWorkspaceInvitation,
	type Workspace,
	type WorkspaceAccess,
	type WorkspaceDetails,
	type WorkspaceInvitation,
	type WorkspaceRole,
} from "@sugabots/contracts";
import {
	type ComputerMadeMeanwhile,
	ComputerUnavailable,
} from "@sugabots/contracts/errors/computers";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import {
	AlreadyInvited,
	AlreadyInWorkspace,
	EmailUnverified,
	OwnerStays,
	SlugShapedLikeUuid,
	SlugTaken,
	type SubscriptionInUse,
	TimeZoneUnknown,
} from "@sugabots/contracts/errors/workspace";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer } from "effect";
import { workspacePermissions } from "../../authorization/permissions.ts";
import type { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import {
	afterCommit,
	type Database,
	query,
	queryCatching,
	serviceOperations,
	type Transaction,
	transaction,
} from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import { bot, invitation, member, membership, workspace } from "../../database/schema.ts";
import { Email } from "../../email/email.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { HoldsInvitation } from "../../proofs/holds-invitation.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type {
	CanChangeMembership,
	CanDeleteWorkspace,
	CanHandOverOwnership,
	CanInvite,
	CanLeaveWorkspace,
} from "../../proofs/membership-changes.ts";
import type { CanManageWorkspace, CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { MemberSignIns } from "../../providers/member-sign-ins.ts";
import { offeredModels } from "../../providers/model-providers/model-provider-reads.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { SearchProviderStore } from "../../providers/search-providers/search-provider-store.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { invitationPath } from "../../server-settings/web-app-paths.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { BotStore } from "../bots/bot-store.ts";
import { PersonalAssistants } from "../bots/personal-assistants.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";

/**
 * The workspaces members are in, who else is, and who is invited, for
 * operations that have proved what each call needs. Each method takes the
 * workspace and the members it acts on from its proofs.
 *
 * A change to who is in a workspace is proved under the workspace's lock, in
 * the transaction that makes it, so it takes its prover's effect (see
 * {@link UnderLock}) rather than a proof, and runs it in that transaction.
 */
export interface Interface {
	/** The workspaces the member is in, in the order they joined them. */
	readonly workspaces: <P>(isMember: IsMember<P>) => Effect.Effect<readonly Workspace[]>;
	/** A workspace owned by the member, with its system bots, built-in providers and their Personal Assistant. */
	readonly create: <P>(
		isMember: IsMember<P>,
		details: NewWorkspace,
	) => Effect.Effect<Workspace, SlugTaken | SlugShapedLikeUuid | TimeZoneUnknown>;
	readonly update: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		details: WorkspaceDetails,
	) => Effect.Effect<Workspace, SlugTaken | SlugShapedLikeUuid | ResourceHidden>;
	/** The reader's role in the workspace and what it lets them do there. */
	readonly access: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<WorkspaceAccess>;
	readonly memberships: <P, W>(
		canRead: CanReadWorkspace<P, W>,
	) => Effect.Effect<readonly Membership[]>;
	/** Gives the member the role their proof says. A proof of a removal is a defect here. */
	readonly changeRole: <P, W, U, E>(
		canChange: UnderLock<CanChangeMembership<P, W, U>, E>,
	) => Effect.Effect<void, E>;
	/**
	 * Takes the member out. Their Personal Assistant, pins and project
	 * memberships go with them, and so does what signs in as them (see
	 * `MemberSignIns`); nobody is removed while a model provider signs in with
	 * their subscription. A proof of a role change is a defect here.
	 */
	readonly remove: <P, W, U, E>(
		canChange: UnderLock<CanChangeMembership<P, W, U>, E>,
	) => Effect.Effect<void, E | SubscriptionInUse | ComputerUnavailable | ComputerMadeMeanwhile>;
	/**
	 * Takes the member leaving out, as a removal does. The owner stays until
	 * they have handed ownership over.
	 */
	readonly leave: <P, W, E>(
		canLeave: UnderLock<CanLeaveWorkspace<P, W>, E>,
	) => Effect.Effect<
		void,
		E | OwnerStays | SubscriptionInUse | ComputerUnavailable | ComputerMadeMeanwhile
	>;
	/**
	 * Makes the member the workspace's owner, and the owner an administrator,
	 * together. Handing it to the owner changes nothing.
	 */
	readonly handOverOwnership: <P, W, U, E>(
		canHandOver: UnderLock<CanHandOverOwnership<P, W, U>, E>,
	) => Effect.Effect<void, E>;
	/** The invitations still waiting to be accepted. */
	readonly invitations: <P, W>(
		canRead: CanReadWorkspace<P, W>,
	) => Effect.Effect<readonly WorkspaceInvitation[]>;
	/** Invites `invitation.email` with the role the proof allows, and emails them once that commits. */
	readonly invite: <P, W, E>(
		canInvite: UnderLock<CanInvite<P, W>, E>,
		invitation: Omit<NewWorkspaceInvitation, "role">,
	) => Effect.Effect<WorkspaceInvitation, E | AlreadyInWorkspace | AlreadyInvited>;
	/** Cancels the invitation, still pending in the workspace with the role the proof allows. */
	readonly cancelInvitation: <P, W, E>(
		canInvite: UnderLock<CanInvite<P, W>, E>,
		invitationId: string,
	) => Effect.Effect<void, E | ResourceHidden>;
	/** The invitation as its holder sees it before accepting. */
	readonly invitation: <P, I, E>(
		holds: UnderLock<HoldsInvitation<P, I>, E>,
	) => Effect.Effect<InvitationPreview, E>;
	/** Lets the invitation's holder in, with their Personal Assistant. */
	readonly accept: <P, I, E>(
		holds: UnderLock<HoldsInvitation<P, I>, E>,
	) => Effect.Effect<{ workspaceId: string }, E>;
	/**
	 * The workspace of an invitation the member can't hold: one they accepted,
	 * while they are still in its workspace, so its link leads back in. One
	 * addressed to them that waits for them to verify their address says so;
	 * anything else is hidden.
	 */
	readonly alreadyAccepted: <P>(
		isMember: IsMember<P>,
		invitationId: string,
	) => Effect.Effect<{ workspaceId: string }, ResourceHidden | EmailUnverified>;
	/**
	 * Deletes the workspace: its projects, bots, chats and providers go with
	 * it, and its members lose it. What its models cost stays on the ledger.
	 * Its computers are destroyed first, outside any transaction, so no lock
	 * waits on a provider and each destroyed computer's record is forgotten for
	 * good, letting a retry resume. Then it is proved again under the lock
	 * before the delete, so an owner who hands ownership on meanwhile no longer
	 * deletes it; the new owner keeps it, with its computers destroyed, and
	 * projects remake theirs when next used. When a provider can't be reached,
	 * or a computer is made meanwhile, the workspace is kept, to try again.
	 */
	readonly delete: <P, W, E>(
		canDelete: UnderLock<CanDeleteWorkspace<P, W>, E>,
	) => Effect.Effect<void, E | ComputerUnavailable | ComputerMadeMeanwhile>;
}

/**
 * A prover's effect that takes the workspace's lock, such as
 * `proveCanChangeMembership(...)`, not yet run: the change runs it in the
 * transaction it is made in, so the lock is held until that commits.
 */
export type UnderLock<Proven, E> = Effect.Effect<Proven, E, Database | Transaction>;

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Membership") {
	declare readonly [Tier]: "process";
}

/** What making a workspace and letting a member in are built from. */
type Provisioning =
	| BotStore.Service
	| SearchProviderStore.Service
	| ModelProviderStore.Service
	| PersonalAssistants.Service;

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Membership");
	const email = yield* Email.Service;
	const serverSettings = yield* ServerSettings.Service;
	const sender = yield* Email.transactionalSender;
	const projectComputers = yield* ProjectComputers.Service;
	const memberSignIns = yield* MemberSignIns.Service;
	const ids = yield* Ids.Service;
	const provisioning = yield* Effect.context<Provisioning>();

	/**
	 * Removes the membership, which cascades to their Personal Assistant, pins
	 * and project memberships, and forgets what signs in as them, unless a
	 * model provider signs in with their subscription. That is checked first,
	 * so a refusal leaves everything as it was. Their assistant's computer is
	 * destroyed next: its record is the only way to find the machine, so when
	 * the provider can't be reached, or a computer is made meanwhile, the
	 * membership stays, to try again.
	 */
	const deleteMembership = (removed: { workspaceId: string; memberId: string }) =>
		Effect.gen(function* () {
			yield* memberSignIns.forget(removed);
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
				yield* projectComputers.destroy(assistantProject).pipe(asComputerUnavailable);
				yield* ProjectComputers.lockWithoutComputer(assistantProject);
			}
			yield* query((db) =>
				db
					.delete(membership)
					.where(
						and(
							eq(membership.workspaceId, removed.workspaceId),
							eq(membership.memberId, removed.memberId),
						),
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
		workspaces: (isMember) =>
			operation(
				"workspaces",
				query((db) =>
					db
						.select(workspaceColumns)
						.from(membership)
						.innerJoin(workspace, eq(workspace.id, membership.workspaceId))
						.where(eq(membership.memberId, isMember.member))
						.orderBy(asc(membership.createdAt)),
				).pipe(Effect.map((rows) => rows.map(workspaceView))),
			),

		create: (isMember, details) =>
			operation(
				"create",
				Effect.gen(function* () {
					yield* requireSlugUnlikeUuid(details.slug);
					if (details.timeZone !== undefined) {
						yield* requireTimeZoneKnownToPostgres(details.timeZone);
					}
					return yield* createWorkspace(isMember.member, details).pipe(
						Effect.provideContext(provisioning),
					);
				}),
			),

		update: (canManage, details) =>
			operation(
				"update",
				Effect.gen(function* () {
					yield* requireSlugUnlikeUuid(details.slug);
					const [updated] = yield* queryCatching(
						(db) =>
							db
								.update(workspace)
								.set(details)
								.where(eq(workspace.id, canManage.inWorkspace.workspace.value))
								.returning(workspaceColumns),
						(failure) => (isUniqueViolation(failure) ? new SlugTaken() : undefined),
					);
					if (!updated) return yield* new ResourceHidden({ resource: "workspace" });
					return workspaceView(updated);
				}),
			),

		access: (canRead) =>
			operation(
				"access",
				Effect.succeed({
					role: canRead.actor.workspaceRole,
					permissions: workspacePermissions(canRead.actor),
				}),
			),

		memberships: (canRead) =>
			operation(
				"memberships",
				Effect.gen(function* () {
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
							.where(eq(membership.workspaceId, canRead.inWorkspace.workspace.value))
							.orderBy(asc(membership.createdAt)),
					);
					return rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
				}),
			),

		changeRole: (proving) =>
			operation(
				"changeRole",
				transaction(
					Effect.gen(function* () {
						const canChange = yield* proving;
						const { change } = canChange;
						if (change.kind !== "role") {
							return yield* Effect.die(new Error("A role change was given a removal's proof"));
						}
						// Promoting puts them in every project members made, by the
						// `administrator_projects` trigger; demoting leaves their projects as they are.
						yield* setRole(canChange.workspace.value, canChange.member.value, change.role);
					}),
				),
			),

		remove: (proving) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						const canChange = yield* proving;
						if (canChange.change.kind !== "removal") {
							return yield* Effect.die(new Error("A removal was given a role change's proof"));
						}
						yield* deleteMembership({
							workspaceId: canChange.workspace.value,
							memberId: canChange.member.value,
						});
					}),
				),
			),

		leave: (proving) =>
			operation(
				"leave",
				transaction(
					Effect.gen(function* () {
						const canLeave = yield* proving;
						if (canLeave.role === "owner") return yield* new OwnerStays();
						yield* deleteMembership({
							workspaceId: canLeave.workspace.value,
							memberId: canLeave.member,
						});
					}),
				),
			),

		handOverOwnership: (proving) =>
			operation(
				"handOverOwnership",
				transaction(
					Effect.gen(function* () {
						const canHandOver = yield* proving;
						if (canHandOver.currentRole === "owner") return;
						const workspaceId = canHandOver.workspace.value;
						// The owner steps down first: `membership_owner_idx` allows
						// one owner, and would refuse the new one while the old one stands.
						// The new owner joins every project members made by the
						// `administrator_projects` trigger, as an admin would.
						yield* query((db) =>
							db
								.update(membership)
								.set({ role: "admin" })
								.where(and(eq(membership.workspaceId, workspaceId), eq(membership.role, "owner"))),
						);
						yield* setRole(workspaceId, canHandOver.member.value, "owner");
					}),
				),
			),

		invitations: (canRead) =>
			operation(
				"invitations",
				Effect.gen(function* () {
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
									eq(invitation.workspaceId, canRead.inWorkspace.workspace.value),
									eq(invitation.status, "pending"),
								),
							)
							.orderBy(asc(invitation.createdAt)),
					);
					return rows.map(invitationView);
				}),
			),

		invite: (proving, invited) =>
			operation(
				"invite",
				transaction(
					Effect.gen(function* () {
						const canInvite = yield* proving;
						const workspaceId = canInvite.workspace.value;
						const { role, inviter: inviterId } = canInvite;
						const address = invited.email.toLowerCase();
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
						if (outstanding && !invited.resend) return yield* new AlreadyInvited();

						const [row] = outstanding
							? yield* query((db) =>
									db
										.update(invitation)
										.set({ role, expiresAt, inviterId })
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
												.values({ id, workspaceId, email: address, role, inviterId, expiresAt })
												.returning(),
										),
								);
						if (!row) return yield* Effect.die(new Error("The invitation was not saved"));
						yield* sendInvitation(row.id, address, workspaceId, inviterId);
						return invitationView(row);
					}),
				),
			),

		cancelInvitation: (proving, invitationId) =>
			operation(
				"cancelInvitation",
				transaction(
					Effect.gen(function* () {
						const canInvite = yield* proving;
						const [canceled] = yield* query((db) =>
							db
								.update(invitation)
								.set({ status: "canceled" })
								.where(
									and(
										eq(invitation.id, invitationId),
										eq(invitation.workspaceId, canInvite.workspace.value),
										eq(invitation.status, "pending"),
										// Sent again with another role since it was read, it needs proving again.
										eq(invitation.role, canInvite.role),
									),
								)
								.returning({ id: invitation.id }),
						);
						if (!canceled) return yield* new ResourceHidden({ resource: "invitation" });
					}),
				),
			),

		invitation: (proving) =>
			operation(
				"invitation",
				transaction(
					Effect.gen(function* () {
						const holds = yield* proving;
						const [found] = yield* query((db) =>
							db
								.select({ workspaceName: workspace.name, inviterName: member.name })
								.from(invitation)
								.innerJoin(workspace, eq(workspace.id, invitation.workspaceId))
								.innerJoin(member, eq(member.id, invitation.inviterId))
								.where(eq(invitation.id, holds.invitation.value)),
						);
						if (!found) return yield* Effect.die(new Error("The invitation held is missing"));
						return { status: "pending" as const, ...found, role: holds.role };
					}),
				),
			),

		accept: (proving) =>
			operation(
				"accept",
				transaction(
					Effect.gen(function* () {
						const holds = yield* proving;
						yield* query((db) =>
							db
								.update(invitation)
								.set({ status: "accepted" })
								.where(eq(invitation.id, holds.invitation.value)),
						);
						yield* join(holds.workspace, holds.member, holds.role).pipe(
							Effect.provideContext(provisioning),
						);
						return { workspaceId: holds.workspace };
					}),
				),
			),

		alreadyAccepted: (isMember, invitationId) =>
			operation(
				"alreadyAccepted",
				Effect.gen(function* () {
					const hidden = new ResourceHidden({ resource: "invitation" });
					if (!isUuid(invitationId)) return yield* hidden;
					const now = yield* DateTime.nowAsDate;
					const [found] = yield* query((db) =>
						db
							.select({
								status: invitation.status,
								expiresAt: invitation.expiresAt,
								workspaceId: invitation.workspaceId,
								stillIn: membership.id,
								emailVerified: member.emailVerified,
							})
							.from(invitation)
							.innerJoin(member, eq(member.id, isMember.member))
							.leftJoin(
								membership,
								and(
									eq(membership.workspaceId, invitation.workspaceId),
									eq(membership.memberId, member.id),
								),
							)
							.where(
								and(
									eq(invitation.id, invitationId),
									eq(invitation.email, sql`lower(${member.email})`),
								),
							),
					);
					if (!found) return yield* hidden;
					if (found.status === "accepted" && found.stillIn !== null) {
						return { workspaceId: found.workspaceId };
					}
					if (found.status === "pending" && found.expiresAt > now && !found.emailVerified) {
						return yield* new EmailUnverified();
					}
					return yield* hidden;
				}),
			),

		delete: (proving) =>
			operation(
				"delete",
				Effect.gen(function* () {
					const { workspace: workspaceId } = yield* transaction(proving);
					yield* projectComputers.destroyAllIn(workspaceId.value).pipe(asComputerUnavailable);
					yield* transaction(
						Effect.gen(function* () {
							const canDelete = yield* proving;
							yield* ProjectComputers.lockWorkspaceWithoutComputers(canDelete.workspace.value);
							yield* query((db) =>
								db.delete(workspace).where(eq(workspace.id, canDelete.workspace.value)),
							);
						}),
					);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([
		PersonalAssistants.layer,
		BotStore.layer,
		SearchProviderStore.layer,
		ModelProviderStore.layer,
		ProjectComputers.layer,
		MemberSignIns.layer,
	]),
);

/**
 * Makes a workspace owned by `ownerId`, with its system bots, its default
 * search provider, its built-in model providers and the owner's Personal
 * Assistant: what `create` does once it has proved who asks. The seeds make
 * theirs with it, the way the app does.
 */
export const createWorkspace = (ownerId: string, details: NewWorkspace) =>
	transaction(
		Effect.gen(function* () {
			const bots = yield* BotStore.Service;
			const searchProviders = yield* SearchProviderStore.Service;
			const modelProviders = yield* ModelProviderStore.Service;
			const personalAssistants = yield* PersonalAssistants.Service;
			const [created] = yield* queryCatching(
				(db) => db.insert(workspace).values(details).returning(workspaceColumns),
				(failure) => (isUniqueViolation(failure) ? new SlugTaken() : undefined),
			);
			if (!created) return yield* Effect.die(new Error("The workspace was not created"));
			yield* query((db) =>
				db.insert(membership).values({ workspaceId: created.id, memberId: ownerId, role: "owner" }),
			);
			yield* bots.createSystemBots({ workspaceId: created.id, createdById: ownerId });
			yield* searchProviders.provisionDefault(created.id, ownerId);
			yield* modelProviders.seedBuiltInProviders(created.id);
			yield* personalAssistants.provision({ workspaceId: created.id, memberId: ownerId });
			return workspaceView(created);
		}),
	);

/**
 * Lets `memberId` into the workspace with `role`, and gives them their
 * Personal Assistant, on the workspace's default model, or on another the
 * workspace offers while it does not offer that one: what accepting an
 * invitation does once it is proved. Letting in somebody already in it
 * changes nothing. The seeds let their members in with it.
 */
export const join = (workspaceId: string, memberId: string, role: AssignableWorkspaceRole) =>
	Effect.gen(function* () {
		const personalAssistants = yield* PersonalAssistants.Service;
		const [joined] = yield* query((db) =>
			db
				.insert(membership)
				.values({ workspaceId, memberId, role })
				.onConflictDoNothing()
				.returning({ id: membership.id }),
		);
		if (!joined) return;
		const { models, defaultModel } = yield* offeredModels(workspaceId);
		// The default goes unoffered while a failed test has its provider off.
		const model = models.some((offered) => offered.modelId === defaultModel)
			? defaultModel
			: models[0]?.modelId;
		const provisioned = model
			? personalAssistants.provisionWithModel({ workspaceId, memberId, model }).pipe(
					// Switched off since it was read: start on none, as while the workspace offers none.
					Effect.catchTag("ModelNotEnabled", () =>
						personalAssistants.provision({ workspaceId, memberId }),
					),
				)
			: personalAssistants.provision({ workspaceId, memberId });
		yield* provisioned;
	});

/** Gives `memberId` the role `role` in the workspace. */
function setRole(workspaceId: string, memberId: string, role: WorkspaceRole) {
	return query((db) =>
		db
			.update(membership)
			.set({ role })
			.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, memberId))),
	);
}

/** A computer provider core couldn't reach, as the operations' error says it. */
function asComputerUnavailable<A, R>(
	effect: Effect.Effect<A, Computers.Unavailable, R>,
): Effect.Effect<A, ComputerUnavailable, R> {
	return effect.pipe(
		Effect.catchTag("ComputerUnavailable", (failure) =>
			Effect.fail(
				new ComputerUnavailable({
					provider: failure.provider,
					reason: failure.reason,
					cause: failure.cause,
				}),
			),
		),
	);
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
