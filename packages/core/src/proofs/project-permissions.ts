import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { ProjectPermission } from "../authorization/permissions.ts";
import {
	type MemberPlace,
	managesProject,
	mayInProjectAs,
	memberActing,
	type ProjectFacts,
	type ReachedAs,
} from "./facts.ts";
import { defineProof, type Proof } from "./proof.ts";
import type { ReachesChat } from "./reaches-chat.ts";
import type { ReachesProject } from "./reaches-project.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

/**
 * What P may do in a project or a chat it reaches. Each is a pure function of
 * the reach proof, by the project grant table for the member acting (a member
 * signed in, or a bot's asker within its bounds). A run may do what its bot
 * reaches but manages nothing and changes no one's place; a webhook call and
 * system work hold no permission where they reach.
 */

/** P may post and react in the chat C. A viewer takes part; a viewer's bot changes nothing. */
export interface CanTakePart<P, C> extends Proof<"CanTakePart", [P, C]> {
	readonly reach: ReachesChat<P, C>;
}

/** P may change the chat C, such as marking it resolved. A viewer, and a viewer's bot, may not. */
export interface CanChangeChat<P, C> extends Proof<"CanChangeChat", [P, C]> {
	readonly reach: ReachesChat<P, C>;
}

/**
 * P manages the project J: its settings, connectors and their tool access,
 * automations, computer, computer use and allowed hosts. In a project members
 * made, its owner and admins; in a bot's default project, the bot's managers.
 */
export interface CanManageProject<P, J> extends Proof<"CanManageProject", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member whose permissions gave it: a member signed in, or a bot's asker. */
	readonly member: MemberPlace;
}

/**
 * P may change which hosts the project J's computer may reach beyond the
 * workspace's: whoever manages J. A bot may only in member bounds, where each
 * change asks its member: a bot in a chat asks for a host instead, which J's
 * managers decide.
 */
export interface CanChangeAllowedHosts<P, J> extends Proof<"CanChangeAllowedHosts", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member whose permissions gave it, whom a host they add records. */
	readonly member: MemberPlace;
}

/**
 * P may see the project J's connectors and their settings: a member or asker
 * whose role reads them there, which is anyone who reaches J, or a run, which
 * may read what its bot reaches. A webhook call and system work read none.
 */
export interface CanReadConnectors<P, J> extends Proof<"CanReadConnectors", [P, J]> {
	readonly reach: ReachesProject<P, J>;
}

/**
 * P may change the project J's name, address, colour, description,
 * visibility and lead bot: in a project members made, its owner and admins. A
 * bot's default project has no settings of its own, so nobody changes them.
 * A bot may only in member bounds, as its visibility and lead change who
 * reaches it. Proved under J's workspace's lock, from a reach proved there
 * too, as its lead bot is one of its members.
 */
export interface CanChangeProjectSettings<P, J> extends Proof<"CanChangeProjectSettings", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member whose permissions gave it: a member signed in, or a bot's asker. */
	readonly member: MemberPlace;
}

/**
 * P may invite and remove the project J's members, and add and remove its
 * bots: any of its members but viewers, in a project members made. A bot may
 * only in member bounds, as this changes who reaches what. Proved under J's
 * workspace's lock, from a reach proved there too.
 */
export interface CanChangeProjectMembers<P, J> extends Proof<"CanChangeProjectMembers", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member whose permissions gave it: a member signed in, or a bot's asker. */
	readonly member: MemberPlace;
}

/**
 * P may delete the project J, with everything in it: in a project members
 * made, its owner and admins. A bot's default project is made and deleted
 * with its bot, so nobody deletes it on its own. A bot may only in member
 * bounds, as this changes who reaches what. Proved under J's workspace's
 * lock, from a reach proved there too, when deletion starts and when it
 * finishes.
 */
export interface CanDeleteProject<P, J> extends Proof<"CanDeleteProject", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member whose permissions gave it: a member signed in, or a bot's asker. */
	readonly member: MemberPlace;
}

/**
 * P's member may take themselves out of the project J: anyone in a project
 * members made but the owner and admins, who stay in every one. A bot, for its
 * asker, may only in member bounds, as this changes who reaches what. Proved
 * under J's workspace's lock, from a reach proved there too.
 */
export interface CanLeaveProject<P, J> extends Proof<"CanLeaveProject", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member who leaves, whom the write takes from here. */
	readonly member: MemberPlace;
}

/**
 * P's member may start a manual run of the project J's automations: anyone
 * reaching it but a viewer, by `automation.run`. A bot may for its asker,
 * within its bounds; a run, a webhook call and system work may not, as a
 * manual run is somebody's.
 */
export interface CanRunAutomations<P, J> extends Proof<"CanRunAutomations", [P, J]> {
	readonly reach: ReachesProject<P, J>;
	/** The member the run is started for, whom it records: a member signed in, or a bot's asker. */
	readonly member: MemberPlace;
}

export interface CanReadProjectRuns<P, J> extends Proof<"CanReadProjectRuns", [P, J]> {
	readonly reach: ReachesProject<P, J>;
}

const CanReadProjectRunsProof = defineProof("CanReadProjectRuns");

export const proveCanReadProjectRuns = <P, J>(
	reach: ReachesProject<P, J>,
): Effect.Effect<CanReadProjectRuns<P, J>, ResourceHidden> => {
	const { kind } = reach.as;
	if (kind !== "member" && kind !== "asker" && kind !== "run") {
		return Effect.fail(new ResourceHidden({ resource: "project" }));
	}
	return Effect.succeed(CanReadProjectRunsProof.prove([reach.principal, reach.project], { reach }));
};

const CanTakePartProof = defineProof("CanTakePart");
const CanChangeChatProof = defineProof("CanChangeChat");
const CanManageProjectProof = defineProof("CanManageProject");
const CanChangeAllowedHostsProof = defineProof("CanChangeAllowedHosts");

const CanReadConnectorsProof = defineProof("CanReadConnectors");
const CanChangeProjectSettingsProof = defineProof("CanChangeProjectSettings");
const CanChangeProjectMembersProof = defineProof("CanChangeProjectMembers");
const CanDeleteProjectProof = defineProof("CanDeleteProject");
const CanLeaveProjectProof = defineProof("CanLeaveProject");
const CanRunAutomationsProof = defineProof("CanRunAutomations");

/**
 * The member whose permissions decide a change to who reaches the project: a
 * member signed in, or a bot's asker in member bounds. None for anyone else.
 */
function memberChangingReach(as: ReachedAs): MemberPlace | undefined {
	if (as.kind === "member") return as.place;
	if (as.kind === "asker" && as.bounds.kind === "member") return as.place;
	return undefined;
}

/**
 * Whether the principal `as` describes may change what is in the project,
 * such as marking its chats resolved: a member or asker with
 * `project.change`, or a run. `CanChangeChat`.
 */
export function changesIn(as: ReachedAs, project: ProjectFacts): boolean {
	if (as.kind === "run") return true;
	const member = memberActing(as);
	return member !== undefined && mayInProjectAs(member, project, "project.change");
}

/** The member whose permissions let `as` manage the project, if they do. `CanManageProject`. */
export function memberManaging(as: ReachedAs, project: ProjectFacts): MemberPlace | undefined {
	const member = memberActing(as);
	return member && managesProject(member, project) ? member : undefined;
}

/**
 * The member whose permissions let `as` change the project's settings, if
 * they do. `CanChangeProjectSettings`.
 */
export function memberChangingSettings(
	as: ReachedAs,
	project: ProjectFacts,
): MemberPlace | undefined {
	return memberChangingReachWith(as, project, "project.update");
}

/**
 * The member whose permissions let `as` invite and remove the project's
 * members, and add and remove its bots, if they do. `CanChangeProjectMembers`.
 */
export function memberChangingMembers(
	as: ReachedAs,
	project: ProjectFacts,
): MemberPlace | undefined {
	return memberChangingReachWith(as, project, "project.members.manage");
}

/** The member whose permissions let `as` delete the project, if they do. `CanDeleteProject`. */
export function memberDeleting(as: ReachedAs, project: ProjectFacts): MemberPlace | undefined {
	return memberChangingReachWith(as, project, "project.delete");
}

/** The member `as` would take out of the project, if they may leave it. `CanLeaveProject`. */
export function memberLeaving(as: ReachedAs, project: ProjectFacts): MemberPlace | undefined {
	return memberChangingReachWith(as, project, "project.leave");
}

/**
 * The member a manual run of the project's automations would be started for,
 * if `as` may start one. `CanRunAutomations`.
 */
export function memberStartingRuns(as: ReachedAs, project: ProjectFacts): MemberPlace | undefined {
	const member = memberActing(as);
	return member && mayInProjectAs(member, project, "automation.run") ? member : undefined;
}

/** The member changing who reaches the project, when the grant tables give them `permission` there. */
function memberChangingReachWith(
	as: ReachedAs,
	project: ProjectFacts,
	permission: ProjectPermission,
): MemberPlace | undefined {
	const member = memberChangingReach(as);
	return member && mayInProjectAs(member, project, permission) ? member : undefined;
}

export const proveCanTakePart = <P, C>(
	reach: ReachesChat<P, C>,
): Effect.Effect<CanTakePart<P, C>, ActionForbidden> => {
	const { as } = reach;
	const takesPart = as.kind === "member" || changesIn(as, reach.project);
	if (!takesPart) return Effect.fail(new ActionForbidden({ proof: "CanTakePart" }));
	const proof: CanTakePart<P, C> = CanTakePartProof.prove([reach.principal, reach.chat], { reach });
	return Effect.succeed(proof);
};

export const proveCanChangeChat = <P, C>(
	reach: ReachesChat<P, C>,
): Effect.Effect<CanChangeChat<P, C>, ActionForbidden> => {
	if (!changesIn(reach.as, reach.project)) {
		return Effect.fail(new ActionForbidden({ proof: "CanChangeChat" }));
	}
	const proof: CanChangeChat<P, C> = CanChangeChatProof.prove([reach.principal, reach.chat], {
		reach,
	});
	return Effect.succeed(proof);
};

export const proveCanManageProject = <P, J>(
	reach: ReachesProject<P, J>,
): Effect.Effect<CanManageProject<P, J>, ActionForbidden> => {
	const member = memberManaging(reach.as, reach.facts);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanManageProject" }));
	}
	const proof: CanManageProject<P, J> = CanManageProjectProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};

export const proveCanChangeAllowedHosts = <P, J>(
	reach: ReachesProject<P, J>,
): Effect.Effect<CanChangeAllowedHosts<P, J>, ActionForbidden> => {
	// Allowed hosts change only where a change to who reaches what may: in member bounds.
	const member = memberChangingReach(reach.as);
	if (!member || !managesProject(member, reach.facts)) {
		return Effect.fail(new ActionForbidden({ proof: "CanChangeAllowedHosts" }));
	}
	const proof: CanChangeAllowedHosts<P, J> = CanChangeAllowedHostsProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};

export const proveCanReadConnectors = <P, J>(
	reach: ReachesProject<P, J>,
): Effect.Effect<CanReadConnectors<P, J>, ActionForbidden> => {
	const { as } = reach;
	const member = memberActing(as);
	const reads =
		as.kind === "run" ||
		(member !== undefined && mayInProjectAs(member, reach.facts, "connector.read"));
	if (!reads) return Effect.fail(new ActionForbidden({ proof: "CanReadConnectors" }));
	const proof: CanReadConnectors<P, J> = CanReadConnectorsProof.prove(
		[reach.principal, reach.project],
		{ reach },
	);
	return Effect.succeed(proof);
};

export const proveCanChangeProjectSettings = <P, W, J>(
	lock: HoldsWorkspaceLock<P, W>,
	reach: ReachesProject<P, J>,
): Effect.Effect<CanChangeProjectSettings<P, J>, ActionForbidden | ResourceHidden> => {
	if (reach.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "project" }));
	}
	const member = memberChangingSettings(reach.as, reach.facts);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanChangeProjectSettings" }));
	}
	const proof: CanChangeProjectSettings<P, J> = CanChangeProjectSettingsProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};

export const proveCanChangeProjectMembers = <P, W, J>(
	lock: HoldsWorkspaceLock<P, W>,
	reach: ReachesProject<P, J>,
): Effect.Effect<CanChangeProjectMembers<P, J>, ActionForbidden | ResourceHidden> => {
	if (reach.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "project" }));
	}
	const member = memberChangingMembers(reach.as, reach.facts);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanChangeProjectMembers" }));
	}
	const proof: CanChangeProjectMembers<P, J> = CanChangeProjectMembersProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};

export const proveCanDeleteProject = <P, W, J>(
	lock: HoldsWorkspaceLock<P, W>,
	reach: ReachesProject<P, J>,
): Effect.Effect<CanDeleteProject<P, J>, ActionForbidden | ResourceHidden> => {
	if (reach.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "project" }));
	}
	const member = memberDeleting(reach.as, reach.facts);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanDeleteProject" }));
	}
	const proof: CanDeleteProject<P, J> = CanDeleteProjectProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};

export const proveCanLeaveProject = <P, W, J>(
	lock: HoldsWorkspaceLock<P, W>,
	reach: ReachesProject<P, J>,
): Effect.Effect<CanLeaveProject<P, J>, ActionForbidden | ResourceHidden> => {
	if (reach.workspace !== lock.workspace.value) {
		return Effect.fail(new ResourceHidden({ resource: "project" }));
	}
	const member = memberLeaving(reach.as, reach.facts);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanLeaveProject" }));
	}
	const proof: CanLeaveProject<P, J> = CanLeaveProjectProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};

export const proveCanRunAutomations = <P, J>(
	reach: ReachesProject<P, J>,
): Effect.Effect<CanRunAutomations<P, J>, ActionForbidden> => {
	const member = memberStartingRuns(reach.as, reach.facts);
	if (!member) {
		return Effect.fail(new ActionForbidden({ proof: "CanRunAutomations" }));
	}
	const proof: CanRunAutomations<P, J> = CanRunAutomationsProof.prove(
		[reach.principal, reach.project],
		{ reach, member },
	);
	return Effect.succeed(proof);
};
