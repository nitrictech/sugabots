export * as Authorization from "./authorization.ts";

import { Context, Effect, Layer } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import {
	ActionForbidden,
	type AgentStanding,
	type AuthorizationDenied,
	agentStandingFor,
	type PodStanding,
	podStandingFor,
	ResourceHidden,
	requireReach,
	type WorkspaceStanding,
	workspaceStandingFor,
} from "./access.ts";
import { CurrentActor } from "./current-actor.ts";
import {
	type AgentPermission,
	mayInWorkspace,
	type PodPermission,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * Whether the current actor may take an action, asked by every use case
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
	 * `podId` names a channel of a workspace the actor belongs to, whether or
	 * not they are in it, as the directory shows a public one to join.
	 */
	readonly podFound: (
		podId: string,
	) => Effect.Effect<PodStanding, ResourceHidden, CurrentActor.Service>;
	/** `podId` names a channel the actor is in, and the action is one they may take in it. */
	readonly pod: (
		podId: string,
		permission: PodPermission,
	) => Effect.Effect<PodStanding, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * `agentId` names a bot, and the action is one the actor may take on it.
	 * A bot they don't reach is hidden, unless the action is one they may take
	 * anyway, as an administrator changes a private bot.
	 */
	readonly agent: (
		agentId: string,
		permission: AgentPermission,
	) => Effect.Effect<AgentStanding, AuthorizationDenied, CurrentActor.Service>;
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
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => workspaceStandingFor(db, workspaceRef, userId));
					if (!standing) return yield* new ResourceHidden({ resource: "workspace" });
					if (!mayInWorkspace(standing.actor, permission)) {
						return yield* new ActionForbidden({ permission });
					}
					return standing;
				}),
			),

		pod: (podId, permission) =>
			operation(
				"pod",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => podStandingFor(db, podId, userId));
					return yield* decideInPod(standing, permission, "pod");
				}),
			),

		podFound: (podId) =>
			operation(
				"podFound",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => podStandingFor(db, podId, userId));
					if (!standing?.actor.workspaceRole) return yield* new ResourceHidden({ resource: "pod" });
					return standing;
				}),
			),

		agent: (agentId, permission) =>
			operation(
				"agent",
				Effect.gen(function* () {
					const { userId } = yield* CurrentActor.Service;
					const standing = yield* query((db) => agentStandingFor(db, agentId, userId));
					if (!standing) return yield* new ResourceHidden({ resource: "agent" });
					if (standing.may(permission)) return standing;
					return yield* standing.may("agent.read")
						? new ActionForbidden({ permission })
						: new ResourceHidden({ resource: "agent" });
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * Hidden whatever the action, for a pod the actor cannot reach (see
 * `requireReach`). Only once they reach it does being unable to act become
 * forbidden.
 */
function decideInPod<Standing extends PodStanding>(
	standing: Standing | undefined,
	permission: PodPermission,
	resource: "pod",
): Effect.Effect<Standing, AuthorizationDenied> {
	return requireReach(standing, resource).pipe(
		Effect.filterOrFail(
			(reached) => reached.may(permission),
			() => new ActionForbidden({ permission }),
		),
	);
}
