export * as Projects from "./projects.ts";

import type {
	Bot,
	MemberParticipant,
	NewProject,
	Project,
	ProjectMember,
	ProjectUpdate,
} from "@sugabots/contracts";
import type {
	ComputerMadeMeanwhile,
	ComputerUnavailable,
} from "@sugabots/contracts/errors/computers";
import {
	AdministratorInEveryProject,
	type BotNotPublic,
	EmptyProjectUpdate,
	type InvalidProjectDetails,
	type LeadsProjects,
	NotInProject,
	NotInWorkspace,
	type ProjectGone,
	type ProjectSlugTaken,
	type UnusableProjectName,
} from "@sugabots/contracts/errors/projects";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Context, Effect, Layer } from "effect";
import type { Actor } from "../../authorization/permissions.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import type { CanJoinProject } from "../../proofs/can-join-project.ts";
import { type MemberPlace, memberActing, type ProjectFacts } from "../../proofs/facts.ts";
import type {
	CanChangeProjectMembers,
	CanChangeProjectSettings,
	CanDeleteProject,
	CanLeaveProject,
} from "../../proofs/project-permissions.ts";
import type { ReachesBot } from "../../proofs/reaches-bot.ts";
import type { ReachesProject } from "../../proofs/reaches-project.ts";
import type { CanCreateProjects, CanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { projectBots } from "../bots/bot-reads.ts";
import { newProjectDetails, projectSeenAs } from "./project.ts";
import { membersReachingProjectNamed, projectMembers, projectsListedTo } from "./project-reads.ts";
import { ProjectStore } from "./project-store.ts";

/**
 * A workspace's projects, who is in them, and their bots, for operations that
 * have proved what each call needs. Each method takes the workspace and the
 * project from its proofs, and returns projects as the member acting sees
 * them, permissions and all: a member signed in, or a bot's asker.
 */
export interface Interface {
	/** The projects of the workspace its reader is in, and the public ones they could join, by name. */
	readonly list: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<Project[]>;
	/**
	 * A project with the member who may create it in it, led by `lead`, which
	 * must be a public bot of the workspace, at the address `details.slug`, or
	 * one derived from its name when that is left out.
	 */
	readonly create: <P, W, B>(
		canCreate: CanCreateProjects<P, W>,
		lead: ReachesBot<P, B>,
		details: Omit<NewProject, "leadBotId">,
	) => Effect.Effect<
		Project,
		InvalidProjectDetails | UnusableProjectName | ProjectSlugTaken | BotNotPublic
	>;
	/** Changes the project's settings, and with `lead` its lead bot, which must be public. */
	readonly update: <P, J, B>(
		canChange: CanChangeProjectSettings<P, J>,
		changes: Omit<ProjectUpdate, "leadBotId">,
		lead: ReachesBot<P, B> | undefined,
	) => Effect.Effect<Project, EmptyProjectUpdate | ProjectGone | ProjectSlugTaken | BotNotPublic>;
	/**
	 * Deletes the project, with everything in it. Its computer is destroyed at
	 * its provider first, since its record is the only way to find the machine:
	 * when the provider can't be reached, or a computer is made meanwhile, the
	 * project is kept, to try again.
	 */
	readonly remove: <P, J>(
		canDelete: CanDeleteProject<P, J>,
	) => Effect.Effect<void, ComputerUnavailable | ComputerMadeMeanwhile>;
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
	/** Adds `memberId` to the project. Adding somebody already in it changes nothing. */
	readonly addMember: <P, J>(
		canChange: CanChangeProjectMembers<P, J>,
		memberId: string,
	) => Effect.Effect<void, NotInWorkspace>;
	/** Takes `memberId` out of the project. Refuses an administrator, who belongs to every one. */
	readonly removeMember: <P, J>(
		canChange: CanChangeProjectMembers<P, J>,
		memberId: string,
	) => Effect.Effect<void, AdministratorInEveryProject | NotInProject>;
	/** Takes the member leaving out of the project, on the same terms as {@link Interface.removeMember}. */
	readonly leave: <P, J>(
		canLeave: CanLeaveProject<P, J>,
	) => Effect.Effect<void, AdministratorInEveryProject | NotInProject>;
	/**
	 * Puts the member joining in the project. Joining one they are in changes
	 * nothing. Checked again as they join, so a project made private
	 * meanwhile is hidden from them.
	 */
	readonly join: <P, J>(canJoin: CanJoinProject<P, J>) => Effect.Effect<Project, ResourceHidden>;
	/** The project's bots, by name, as the member acting sees them. */
	readonly bots: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<Bot[]>;
	/** Adds `bot`, which must be a public bot of the workspace. Adding one already in it changes nothing. */
	readonly addBot: <P, J, B>(
		canChange: CanChangeProjectMembers<P, J>,
		bot: ReachesBot<P, B>,
	) => Effect.Effect<void, BotNotPublic>;
	/** Refused for the project's lead bot, until another is chosen. */
	readonly removeBot: <P, J>(
		canChange: CanChangeProjectMembers<P, J>,
		botId: string,
	) => Effect.Effect<void, LeadsProjects>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Projects") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Projects");
	const store = yield* ProjectStore.Service;
	const projectComputers = yield* ProjectComputers.Service;

	const takeOut = <P, J>(reach: ReachesProject<P, J>, memberId: string) =>
		Effect.gen(function* () {
			const outcome = yield* store.removeMember(reach.workspace, reach.project.value, memberId);
			switch (outcome) {
				case "removed":
					return;
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
				projectsListedTo(canRead.inWorkspace.workspace.value, canRead.actor.memberId),
			),

		create: (canCreate, lead, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const details = yield* newProjectDetails(input);
					const row = yield* store.create(canCreate.inWorkspace.workspace.value, {
						...input,
						...details,
						creatorId: canCreate.actor.memberId,
						leadBotId: lead.bot.value,
					});
					return projectSeenAs(row, canCreate.actor, { isMember: true, defaultOf: null });
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
					const updated = yield* store.update(
						reach.workspace,
						reach.project.value,
						leadBotId === undefined ? changes : { ...changes, leadBotId },
					);
					return seenByMember(updated, member, reach.facts);
				}),
			),

		remove: (canDelete) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { reach } = canDelete;
					const removed = { workspaceId: reach.workspace, projectId: reach.project.value };
					yield* projectComputers.destroy(removed);
					yield* transaction(
						Effect.andThen(
							ProjectComputers.lockWithoutComputer(removed),
							store.remove(removed.workspaceId, removed.projectId),
						),
					);
				}),
			),

		members: (reach) => operation("members", projectMembers(reach.project.value)),

		membersReaching: (reach) =>
			operation("membersReaching", membersReachingProjectNamed(reach.project.value)),

		addMember: (canChange, memberId) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					const { reach } = canChange;
					if (!(yield* store.addMember(reach.workspace, reach.project.value, memberId))) {
						return yield* new NotInWorkspace();
					}
				}),
			),

		removeMember: (canChange, memberId) =>
			operation("removeMember", takeOut(canChange.reach, memberId)),

		leave: (canLeave) =>
			operation("leave", takeOut(canLeave.reach, canLeave.member.actor.memberId)),

		join: (canJoin) =>
			operation(
				"join",
				Effect.gen(function* () {
					const { member } = canJoin;
					const joined = yield* store.join(
						canJoin.workspace,
						canJoin.project.value,
						member.actor.memberId,
					);
					if (!joined) return yield* new ResourceHidden({ resource: "project" });
					return projectSeenAs(joined, member.actor, { isMember: true, defaultOf: null });
				}),
			),

		bots: (reach) =>
			operation("bots", projectBots(reach.project.value, viewerOf(memberActing(reach.as)))),

		addBot: (canChange, bot) =>
			operation(
				"addBot",
				store.addBot(canChange.reach.workspace, canChange.reach.project.value, bot.bot.value),
			),

		removeBot: (canChange, botId) =>
			operation(
				"removeBot",
				store.removeBot(
					canChange.reach.workspace,
					canChange.reach.project.value,
					botId,
					canChange.member.actor.memberId,
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([ProjectStore.layer, ProjectComputers.layer]));

/** `row` as `member` sees it, from their place in it and the facts its reach was proved from. */
function seenByMember(row: schema.ProjectRow, member: MemberPlace, facts: ProjectFacts): Project {
	return projectSeenAs(row, member.actor, {
		isMember: member.inProject,
		defaultOf: facts.defaultOf,
	});
}

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
