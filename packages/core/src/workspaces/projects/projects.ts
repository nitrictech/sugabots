export * as Projects from "./projects.ts";

import type {
	Bot,
	MemberParticipant,
	Project,
	ProjectMember,
	ProjectUpdate,
} from "@sugabots/contracts";
import type { ComputerMadeMeanwhile } from "@sugabots/contracts/errors/computers";
import {
	AdministratorInEveryProject,
	type BotNotPublic,
	EmptyProjectUpdate,
	type LeadsProjects,
	NotInProject,
	NotInWorkspace,
	type PersonalBotInProject,
	type ProjectGone,
	type ProjectHasPrivateBots,
	type ProjectSlugTaken,
	type UnusableProjectName,
} from "@sugabots/contracts/errors/projects";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Context, Effect, Layer } from "effect";
import type { Actor } from "../../authorization/permissions.ts";
import { type FenceRefusal, holdTurnOf, recordTurnProjectGrant } from "../../chats/turns/turns.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { serviceOperations, Transaction } from "../../database/database.ts";
import { EventOutbox } from "../../database/events/outbox.ts";
import type { Approved } from "../../proofs/approved.ts";
import type { CanJoinProject } from "../../proofs/can-join-project.ts";
import type { ProjectDeletionStarted } from "../../proofs/deletion-started.ts";
import { type MemberPlace, memberActing } from "../../proofs/facts.ts";
import type {
	CanChangeProjectMembers,
	CanChangeProjectSettings,
	CanDeleteProject,
	CanLeaveProject,
} from "../../proofs/project-permissions.ts";
import type { Named } from "../../proofs/proof.ts";
import type { ReachesBot } from "../../proofs/reaches-bot.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import type { HoldsWorkspaceLock } from "../../proofs/workspace-lock.ts";
import type { CanCreateProjects, CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { reachChanged, reachNarrowed } from "../../streams/reach-changes.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { projectBots } from "../bots/bot-reads.ts";
import { newProjectSlug, projectSeenAs } from "./project.ts";
import { membersReachingProjectNamed, projectMembers, projectsListedTo } from "./project-reads.ts";
import { ProjectStore } from "./project-store.ts";

/**
 * A workspace's projects, who is in them, and their bots, for operations that
 * have proved what each call needs. Each method takes the workspace and the
 * project from its proofs, and returns projects as the member acting sees
 * them, permissions and all: a member signed in, or a bot's asker.
 *
 * Making or deleting a project, and changing who is in it, member or bot,
 * its lead included, are proved under its workspace's lock (see
 * `HoldsWorkspaceLock`), demand the transaction that holds it, and record a
 * `reach.changed` event there. Those a bot may do for its asker demand the
 * call's `Approved` proof, and hold its turn's fence in that transaction.
 */
export interface Interface {
	/** The projects of the workspace its reader is in, and the public ones they could join, by name. */
	readonly list: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<Project[]>;
	/**
	 * A project with the member who may create it in it, led by `lead`, a bot
	 * of the workspace that isn't personal, and private only for a private
	 * project, at the address `details.slug`, or one derived from its name when
	 * that is left out.
	 */
	/** Makes the project `approved.input` describes, in the workspace locked, led by `lead`. */
	readonly create: <P, W, B, X>(
		lock: HoldsWorkspaceLock<P, W>,
		canCreate: CanCreateProjects<P, W>,
		lead: ReachesBot<P, B>,
		approved: Approved<P, X, [W, B], "projects.create">,
	) => Effect.Effect<
		Project,
		UnusableProjectName | ProjectSlugTaken | BotNotPublic | PersonalBotInProject | FenceRefusal,
		Transaction
	>;
	/**
	 * Changes the project's settings, and with `lead` its lead bot, which
	 * becomes one of its bots on the terms of {@link Interface.addBot}, under its
	 * workspace's lock, in whose transaction the change is made. A project with
	 * private bots stays private.
	 */
	readonly update: <P, J, B>(
		canChange: CanChangeProjectSettings<P, J>,
		changes: Omit<ProjectUpdate, "leadBotId">,
		lead: ReachesBot<P, B> | undefined,
	) => Effect.Effect<
		Project,
		| EmptyProjectUpdate
		| ProjectGone
		| ProjectSlugTaken
		| BotNotPublic
		| PersonalBotInProject
		| ProjectHasPrivateBots,
		Transaction
	>;
	readonly beginRemoval: <P, J>(
		canDelete: CanDeleteProject<P, J>,
	) => Effect.Effect<ProjectComputers.Project, never, Transaction>;
	readonly remove: <W, J>(
		started: ProjectDeletionStarted<W, J, "project">,
	) => Effect.Effect<void, ComputerMadeMeanwhile, Transaction>;
	/** The members in the project, by name. */
	readonly members: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<ProjectMember[]>;
	/**
	 * The members who reach the project, by name, as a mention in its chats can
	 * name them: in a project members made, its members; in a bot's default
	 * project, which has none, whoever reaches the bot.
	 */
	readonly membersReaching: <P, J>(
		reach: ReachesProject<P, J>,
	) => Effect.Effect<MemberParticipant[]>;
	/** Adds `member` to the project. Adding somebody already in it changes nothing. */
	readonly addMember: <P, J, U>(
		canChange: CanChangeProjectMembers<P, J>,
		member: Named<U, string>,
	) => Effect.Effect<void, NotInWorkspace, Transaction>;
	/** Takes `member` out of the project. Refuses an administrator, who belongs to every one. */
	readonly removeMember: <P, J, U>(
		canChange: CanChangeProjectMembers<P, J>,
		member: Named<U, string>,
	) => Effect.Effect<void, AdministratorInEveryProject | NotInProject, Transaction>;
	/** Takes the member leaving out of the project, on the same terms as {@link Interface.removeMember}. */
	readonly leave: <P, J>(
		canLeave: CanLeaveProject<P, J>,
	) => Effect.Effect<void, AdministratorInEveryProject | NotInProject, Transaction>;
	/**
	 * Puts the member joining in the project. Joining one they are in changes
	 * nothing. Checked again as they join, so a project made private
	 * meanwhile is hidden from them.
	 */
	readonly join: <P, W, J, X>(
		lock: HoldsWorkspaceLock<P, W>,
		canJoin: CanJoinProject<P, J>,
		approved: Approved<P, X, [J], "projects.join">,
	) => Effect.Effect<Project, ResourceHidden | FenceRefusal, Transaction>;
	/** The project's bots, by name, as the member acting sees them. */
	readonly bots: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<Bot[]>;
	/**
	 * Adds `bot`: a public bot to any project, a private bot to a private one,
	 * and a personal bot to none. Adding one already in it changes nothing.
	 */
	readonly addBot: <P, W, J, B, X>(
		lock: HoldsWorkspaceLock<P, W>,
		canChange: CanChangeProjectMembers<P, J>,
		bot: ReachesBot<P, B>,
		approved: Approved<P, X, [J, B], "projects.addBot">,
	) => Effect.Effect<void, BotNotPublic | PersonalBotInProject | FenceRefusal, Transaction>;
	/** Refused for the project's lead bot, until another is chosen. */
	readonly removeBot: <P, J, B>(
		canChange: CanChangeProjectMembers<P, J>,
		bot: Named<B, string>,
	) => Effect.Effect<void, LeadsProjects, Transaction>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Projects") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Projects");
	const store = yield* ProjectStore.Service;
	const outbox = yield* EventOutbox.Service;

	/** Records, in the transaction that changed them, that the project's members or bots changed. */
	const membersChanged = <P, J>(reach: ReachesProject<P, J>) =>
		outbox.publish([
			reachChanged(reach.workspace, { kind: "project", projectId: reach.project.value }),
		]);

	const removeProjectMember = <P, J>(reach: ReachesProject<P, J>, memberId: string) =>
		Effect.gen(function* () {
			yield* Transaction;
			const outcome = yield* store.removeMember(reach.workspace, reach.project.value, memberId);
			switch (outcome) {
				case "removed":
					return yield* outbox.publish([reachNarrowed(reach.workspace)]);
				case "administrator":
					return yield* new AdministratorInEveryProject();
				case "not_a_member":
					return yield* new NotInProject();
			}
		});

	return Service.of({
		list: (canRead) =>
			operation(
				"list",
				Effect.map(
					projectsListedTo(canRead.inWorkspace.workspace.value, canRead.actor.memberId),
					(listed) => listed.map(({ project }) => project),
				),
			),

		create: (lock, canCreate, lead, approved) =>
			operation(
				"create",
				Effect.gen(function* () {
					yield* Transaction;
					yield* holdTurnOf(lock.principal.value, "update");
					// The project's workspace and lead are the proved ones, not the input's.
					const { workspace: _workspace, leadBotId: _leadBotId, ...input } = approved.input;
					const workspaceId = lock.workspace.value;
					const slug = yield* newProjectSlug(input);
					// Its creator, the workspace's owner and admins and its lead are in it from the start.
					const row = yield* store.create(workspaceId, {
						...input,
						slug,
						creatorId: canCreate.actor.memberId,
						leadBotId: lead.bot.value,
					});
					yield* recordTurnProjectGrant(lock.principal.value, row.id);
					yield* outbox.publish([
						reachChanged(workspaceId, { kind: "project", projectId: row.id }),
					]);
					return projectSeenAs(row, { actor: canCreate.actor, inProject: true });
				}),
			),

		update: (canChange, changes, lead) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { reach, member } = canChange;
					const leadBotId = lead?.bot.value;
					if (
						leadBotId === undefined &&
						Object.values(changes).every((value) => value === undefined)
					) {
						return yield* new EmptyProjectUpdate();
					}
					yield* Transaction;
					const updated = yield* store.update(
						reach.workspace,
						reach.project.value,
						leadBotId === undefined ? changes : { ...changes, leadBotId },
					);
					// Made private, it leaves out whoever isn't in it, who must hear it too; a
					// new lead becomes one of its bots.
					if (changes.visibility !== undefined) {
						yield* outbox.publish([reachNarrowed(reach.workspace)]);
					} else if (leadBotId !== undefined) {
						yield* membersChanged(reach);
					}
					return projectSeenAs(updated, member);
				}),
			),

		beginRemoval: ({ reach }) =>
			operation(
				"beginRemoval",
				Effect.gen(function* () {
					yield* Transaction;
					const removed = { workspaceId: reach.workspace, projectId: reach.project.value };
					if (yield* store.markDeleting(removed.workspaceId, removed.projectId)) {
						yield* membersChanged(reach);
					}
					return removed;
				}),
			),

		remove: ({ workspace, project }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const workspaceId = workspace.value;
					const projectId = project.value;
					yield* Transaction;
					yield* ProjectComputers.lockWithoutComputer({ workspaceId, projectId });
					yield* store.remove(workspaceId, projectId);
					yield* outbox.publish([reachChanged(workspaceId, { kind: "project", projectId })]);
				}),
			),

		members: (reach) => operation("members", projectMembers(reach.project.value)),

		membersReaching: (reach) =>
			operation("membersReaching", membersReachingProjectNamed(reach.project.value)),

		addMember: (canChange, member) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					yield* Transaction;
					const { reach } = canChange;
					if (!(yield* store.addMember(reach.workspace, reach.project.value, member.value))) {
						return yield* new NotInWorkspace();
					}
					yield* membersChanged(reach);
				}),
			),

		removeMember: (canChange, member) =>
			operation("removeMember", removeProjectMember(canChange.reach, member.value)),

		leave: (canLeave) =>
			operation("leave", removeProjectMember(canLeave.reach, canLeave.member.actor.memberId)),

		join: (lock, canJoin, _approved) =>
			operation(
				"join",
				Effect.gen(function* () {
					yield* Transaction;
					yield* holdTurnOf(lock.principal.value, "update");
					const { member } = canJoin;
					const joined = yield* store.join(
						canJoin.workspace,
						canJoin.project.value,
						member.actor.memberId,
					);
					if (!joined) return yield* new ResourceHidden({ resource: "project" });
					yield* recordTurnProjectGrant(lock.principal.value, joined.id);
					yield* outbox.publish([
						reachChanged(canJoin.workspace, {
							kind: "project",
							projectId: canJoin.project.value,
						}),
					]);
					return projectSeenAs(joined, { ...member, inProject: true });
				}),
			),

		bots: (reach) =>
			operation("bots", projectBots(reach.project.value, viewerOf(memberActing(reach.as)))),

		addBot: (lock, canChange, bot, _approved) =>
			operation(
				"addBot",
				Effect.gen(function* () {
					yield* Transaction;
					yield* holdTurnOf(lock.principal.value);
					const { reach } = canChange;
					yield* store.addBot(reach.workspace, reach.project.value, bot.bot.value);
					yield* membersChanged(reach);
				}),
			),

		removeBot: (canChange, bot) =>
			operation(
				"removeBot",
				Effect.gen(function* () {
					yield* Transaction;
					const { reach } = canChange;
					yield* store.removeBot(
						reach.workspace,
						reach.project.value,
						bot.value,
						canChange.member.actor.memberId,
					);
					yield* membersChanged(reach);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(ProjectStore.layer));

/**
 * Who a view is shown to, with what they may do: the member acting, or for a
 * principal acting for no member, such as an automation's run, nobody, who may
 * do nothing and has pinned nothing.
 */
function viewerOf(member: MemberPlace | undefined): Actor {
	return member?.actor ?? NOBODY;
}

/** A viewer with no role, whose id is no member's. */
const NOBODY: Actor = {
	memberId: "00000000-0000-0000-0000-000000000000",
	workspaceRole: undefined,
};
