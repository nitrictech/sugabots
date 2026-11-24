export * as Authorization from "./authorization.ts";

import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import {
	ActionForbidden,
	type AuthorizationDenied,
	type BotStanding,
	botStandingFor,
	type ProjectStanding,
	projectStandingFor,
	ResourceHidden,
	requireReach,
	type WorkspaceStanding,
	workspaceStandingFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";
import {
	type BotPermission,
	mayInWorkspace,
	type ProjectPermission,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * Whether the current actor may take an action, asked by every operation
 * before it touches what the action is about.
 *
 * The facts come from `access.ts` and the decisions from `permissions.ts`.
 * Something the actor cannot reach is `ResourceHidden`, whatever they asked,
 * so a refusal never confirms an id; something they reach but may not act on
 * is `ActionForbidden`. Each answer carries the standing it was decided from,
 * so the caller works on what was checked rather than looking it up again.
 */
export interface Interface {
	/**
	 * `workspaceRef` names a workspace the actor belongs to, by its id or its
	 * slug, and the action is one their role grants there. The standing
	 * carries the resolved id, which is what everything after uses.
	 */
	readonly workspace: (
		workspaceRef: string,
		permission: WorkspacePermission,
	) => Effect.Effect<WorkspaceStanding, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * `projectId` names a project of a workspace the actor belongs to, whether or
	 * not they are in it, as the directory shows a public one to join.
	 */
	readonly projectFound: (
		projectId: string,
	) => Effect.Effect<ProjectStanding, ResourceHidden, CurrentActor.Service>;
	/**
	 * `projectId` names a project, and the action is one the actor may take in
	 * it. A project they don't reach is hidden, unless the action is one they
	 * may take anyway, as an administrator manages a personal bot's computer.
	 */
	readonly project: (
		projectId: string,
		permission: ProjectPermission,
	) => Effect.Effect<ProjectStanding, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * `botId` names a bot, and the action is one the actor may take on it.
	 * A bot they don't reach is hidden, unless the action is one they may take
	 * anyway, as an administrator changes a personal bot.
	 */
	readonly bot: (
		botId: string,
		permission: BotPermission,
	) => Effect.Effect<BotStanding, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/Authorization",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Authorization");
	return Service.of({
		workspace: (workspaceRef, permission) =>
			operation(
				"workspace",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => workspaceStandingFor(db, workspaceRef, memberId));
					if (!standing) return yield* new ResourceHidden({ resource: "workspace" });
					if (!mayInWorkspace(standing.actor, permission)) {
						return yield* new ActionForbidden({ permission });
					}
					return standing;
				}),
			),

		project: (projectId, permission) =>
			operation(
				"project",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => projectStandingFor(db, projectId, memberId));
					if (standing?.may(permission)) return standing;
					// Hidden for a project they can't reach; only once they reach it
					// does being unable to act become forbidden.
					yield* requireReach(standing, "project");
					return yield* new ActionForbidden({ permission });
				}),
			),

		projectFound: (projectId) =>
			operation(
				"projectFound",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => projectStandingFor(db, projectId, memberId));
					if (!standing?.actor.workspaceRole)
						return yield* new ResourceHidden({ resource: "project" });
					return standing;
				}),
			),

		bot: (botId, permission) =>
			operation(
				"bot",
				Effect.gen(function* () {
					const { memberId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => botStandingFor(db, botId, memberId));
					if (!standing) return yield* new ResourceHidden({ resource: "bot" });
					if (standing.may(permission)) return standing;
					return yield* standing.may("bot.read")
						? new ActionForbidden({ permission })
						: new ResourceHidden({ resource: "bot" });
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);
