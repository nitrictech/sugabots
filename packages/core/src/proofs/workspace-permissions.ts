import { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import {
	type Actor,
	mayInWorkspace,
	type WorkspacePermission,
} from "../authorization/permissions.ts";
import type { InWorkspace } from "./in-workspace.ts";
import { defineProof, type Proof } from "./proof.ts";

/**
 * What P may do in the workspace W, by the role that gives it workspace
 * permissions: a member's own, or an asker's in member bounds. Each is a pure
 * function of `InWorkspace`, by the workspace grant table.
 */

/** P may see the workspace's members, and its public bots and projects, as its directory lists them. */
export interface CanReadWorkspace<P, W> extends Proof<"CanReadWorkspace", [P, W]> {
	readonly inWorkspace: InWorkspace<P, W>;
	/** The member whose role gives it: a member signed in, or a bot's asker in member bounds. */
	readonly actor: Actor;
}

/** P may manage the workspace's settings, providers, system bots' models and usage. */
export interface CanManageWorkspace<P, W> extends Proof<"CanManageWorkspace", [P, W]> {
	readonly inWorkspace: InWorkspace<P, W>;
	/** The member whose role gives it: a member signed in, or a bot's asker in member bounds. */
	readonly actor: Actor;
}

/** P may make bots in the workspace. */
export interface CanCreateBots<P, W> extends Proof<"CanCreateBots", [P, W]> {
	readonly inWorkspace: InWorkspace<P, W>;
	/** The member whose role gives it: a member signed in, or a bot's asker in member bounds. */
	readonly actor: Actor;
}

/** P may make projects in the workspace. */
export interface CanCreateProjects<P, W> extends Proof<"CanCreateProjects", [P, W]> {
	readonly inWorkspace: InWorkspace<P, W>;
	/** The member whose role gives it: a member signed in, or a bot's asker in member bounds. */
	readonly actor: Actor;
}

const CanReadWorkspaceProof = defineProof("CanReadWorkspace");
const CanManageWorkspaceProof = defineProof("CanManageWorkspace");
const CanCreateBotsProof = defineProof("CanCreateBots");
const CanCreateProjectsProof = defineProof("CanCreateProjects");

/** Whether `actor`'s role lets them see the workspace's directory. `CanReadWorkspace`. */
function readsWorkspace(actor: Actor): boolean {
	return mayInWorkspace(actor, "workspace.read");
}

/**
 * Whether `actor`'s role lets them manage the workspace's settings, providers,
 * system bots' models and usage. `CanManageWorkspace`.
 */
export function managesWorkspace(actor: Actor): boolean {
	return grantsAll(actor, ["workspace.update", "workspace.providers.manage"]);
}

/** Whether `actor`'s role lets them make bots. `CanCreateBots`. */
export function createsBots(actor: Actor): boolean {
	return mayInWorkspace(actor, "bot.create");
}

/** Whether `actor`'s role lets them make projects. `CanCreateProjects`. */
export function createsProjects(actor: Actor): boolean {
	return mayInWorkspace(actor, "project.create");
}

function grantsAll(actor: Actor, permissions: readonly WorkspacePermission[]): boolean {
	return permissions.every((permission) => mayInWorkspace(actor, permission));
}

/** The member whose role `inWorkspace` carries, when `rule` grants it. */
const grantedTo = <P, W>(
	inWorkspace: InWorkspace<P, W>,
	rule: (actor: Actor) => boolean,
): Actor | undefined => {
	const actor = inWorkspace.permissionsOf;
	return actor !== undefined && rule(actor) ? actor : undefined;
};

export const proveCanReadWorkspace = <P, W>(
	inWorkspace: InWorkspace<P, W>,
): Effect.Effect<CanReadWorkspace<P, W>, ActionForbidden> => {
	const actor = grantedTo(inWorkspace, readsWorkspace);
	if (!actor) {
		return Effect.fail(new ActionForbidden({ proof: "CanReadWorkspace" }));
	}
	const proof: CanReadWorkspace<P, W> = CanReadWorkspaceProof.prove(
		[inWorkspace.principal, inWorkspace.workspace],
		{ inWorkspace, actor },
	);
	return Effect.succeed(proof);
};

export const proveCanManageWorkspace = <P, W>(
	inWorkspace: InWorkspace<P, W>,
): Effect.Effect<CanManageWorkspace<P, W>, ActionForbidden> => {
	const actor = grantedTo(inWorkspace, managesWorkspace);
	if (!actor) {
		return Effect.fail(new ActionForbidden({ proof: "CanManageWorkspace" }));
	}
	const proof: CanManageWorkspace<P, W> = CanManageWorkspaceProof.prove(
		[inWorkspace.principal, inWorkspace.workspace],
		{ inWorkspace, actor },
	);
	return Effect.succeed(proof);
};

export const proveCanCreateBots = <P, W>(
	inWorkspace: InWorkspace<P, W>,
): Effect.Effect<CanCreateBots<P, W>, ActionForbidden> => {
	const actor = grantedTo(inWorkspace, createsBots);
	if (!actor) {
		return Effect.fail(new ActionForbidden({ proof: "CanCreateBots" }));
	}
	const proof: CanCreateBots<P, W> = CanCreateBotsProof.prove(
		[inWorkspace.principal, inWorkspace.workspace],
		{ inWorkspace, actor },
	);
	return Effect.succeed(proof);
};

export const proveCanCreateProjects = <P, W>(
	inWorkspace: InWorkspace<P, W>,
): Effect.Effect<CanCreateProjects<P, W>, ActionForbidden> => {
	const actor = grantedTo(inWorkspace, createsProjects);
	if (!actor) {
		return Effect.fail(new ActionForbidden({ proof: "CanCreateProjects" }));
	}
	const proof: CanCreateProjects<P, W> = CanCreateProjectsProof.prove(
		[inWorkspace.principal, inWorkspace.workspace],
		{ inWorkspace, actor },
	);
	return Effect.succeed(proof);
};
