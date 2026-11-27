/**
 * What the API tells a member they may do, so the web app offers only what
 * the operations allow. Each flag is decided by the rule the prover behind
 * its operation checks, for a member signed in, by calling that rule rather
 * than restating it. Nothing here makes a proof.
 */

import type {
	BotPermissions,
	ProjectPermissions,
	ResourcePermissions,
	WorkspacePermissions,
} from "@sugabots/contracts";
import { type Actor, type BotFacts, mayOnBot } from "../authorization/permissions.ts";
import { mayJoin } from "./can-join-project.ts";
import { takesOverDesktop } from "./can-use-computer.ts";
import { memberManagingChats } from "./chat-permissions.ts";
import {
	type MemberPlace,
	managesBot,
	memberReaches,
	memberReachesBot,
	type ProjectFacts,
	type ReachedAs,
	restrictsBot,
} from "./facts.ts";
import {
	deletesWorkspace,
	handsOverOwnership,
	managesMembers,
	mayHandle,
} from "./membership-changes.ts";
import {
	changesIn,
	memberChangingMembers,
	memberChangingSettings,
	memberDeleting,
	memberLeaving,
	memberManaging,
	memberStartingRuns,
} from "./project-permissions.ts";
import { createsBots, createsProjects, managesWorkspace } from "./workspace-permissions.ts";

/** What `actor` may do in the workspace, by the roles its provers check. */
export function workspacePermissionsShown(actor: Actor): WorkspacePermissions {
	const managesIt = managesWorkspace(actor);
	return {
		createProjects: createsProjects(actor),
		createBots: createsBots(actor),
		updateWorkspace: managesIt,
		manageProviders: managesIt,
		manageMembers: managesMembers(actor),
		chooseSystemModel: managesIt,
		manageUsage: managesIt,
		manageAdmins: managesMembers(actor) && mayHandle(actor, "admin"),
		handOverOwnership: handsOverOwnership(actor),
		deleteWorkspace: deletesWorkspace(actor),
	};
}

/** What the member at `place` may do with the project, which is one members made. */
export function projectPermissionsShown(
	place: MemberPlace,
	project: ProjectFacts,
): ProjectPermissions {
	const { decides } = asMember(place, project);
	return {
		rename: decides(memberChangingSettings),
		manageMembers: decides(memberChangingMembers),
		manageBots: decides(memberChangingMembers),
		leave: decides(memberLeaving),
		join: !place.inProject && mayJoin(place, project),
		delete: decides(memberDeleting),
		resources: resourcePermissionsShown(place, project),
	};
}

/**
 * What `actor` may do with the bot, and with what its default project holds.
 * `defaultProject` is that project's id.
 */
export function botPermissionsShown(
	actor: Actor,
	bot: BotFacts & { readonly id: string; readonly workspaceId: string },
	defaultProject: string,
): BotPermissions {
	const facts: BotFacts & { readonly id: string } = {
		id: bot.id,
		visibility: bot.visibility,
		createdById: bot.createdById,
		assistantOf: bot.assistantOf,
		memberIds: bot.memberIds,
	};
	const memberFacing = { ...facts, systemBot: false };
	const managesIt = managesBot(actor, facts);
	return {
		update: managesIt,
		delete: managesIt || restrictsBot(actor, memberFacing),
		talk: memberReachesBot(actor, memberFacing),
		manageMembers: mayOnBot(actor, "bot.members.manage", facts),
		// Nobody is in a default project: it is reached through its bot.
		resources: resourcePermissionsShown(
			{ actor, inProject: false },
			{
				id: defaultProject,
				workspace: bot.workspaceId,
				leadBot: bot.id,
				// Nobody finds or joins a default project, so this decides nothing.
				visibility: "private",
				defaultOf: facts,
			},
		),
	};
}

/**
 * What the member at `place` may do with what the project holds: a project
 * members made, or a bot's default project, whose are the bot's.
 */
function resourcePermissionsShown(place: MemberPlace, project: ProjectFacts): ResourcePermissions {
	const { reaches, decides } = asMember(place, project);
	const manages = decides(memberManaging);
	const restricts =
		project.defaultOf !== null &&
		restrictsBot(place.actor, { ...project.defaultOf, systemBot: false });
	return {
		readHistory: reaches,
		resolveChats: reaches && changesIn({ kind: "member", place }, project),
		// A bot's settings are for whoever manages or restricts it; a project's for anyone in it.
		openSettings: project.defaultOf
			? managesBot(place.actor, project.defaultOf) || restricts
			: reaches,
		deleteFiles: decides(memberManagingChats),
		manageConnectors: manages,
		manageComputer: manages,
		useDesktop: reaches && takesOverDesktop(place, project),
		manageAutomations: manages,
		// An admin restricting a bot they don't reach may only switch its automations off.
		pauseAutomations: manages || restricts,
		runAutomations: decides(memberStartingRuns),
	};
}

/**
 * The member at `place` as the provers meet them in the project: whether they
 * reach it, which every prover there checks first, and whether a rule that
 * names the member it lets act lets them.
 */
function asMember(place: MemberPlace, project: ProjectFacts) {
	const as: ReachedAs = { kind: "member", place };
	const reaches = memberReaches(place, project);
	return {
		reaches,
		decides: (rule: (as: ReachedAs, project: ProjectFacts) => MemberPlace | undefined) =>
			reaches && rule(as, project) !== undefined,
	};
}
