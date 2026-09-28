import { Authorise, CurrentUser, Forbidden, NotFound } from "@sugabots/contracts/http";
import type { Database } from "@sugabots/core/database/database";
import type {
	AgentStanding,
	Authorization,
	AuthorizationDenied,
	PodStanding,
	WorkspaceStanding,
} from "@sugabots/core/workspaces/access";
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { accessRuleFor } from "./access-policy.ts";
import { asHttpError } from "./errors.ts";

/**
 * The `Authorise` middleware: each endpoint's rule in `accessPolicy`, checked against
 * the id in its path before the request is decoded.
 *
 * What the check found is handed to the handler through `grantedWorkspace`,
 * `grantedPod` or `grantedAgent`, so a handler never looks the thing up a
 * second time, and one that asks for a pod its rule did not check fails
 * loudly the first time it runs.
 */

const GrantedWorkspace = Context.Reference<WorkspaceStanding | undefined>(
	"sugabots/server/GrantedWorkspace",
	{ defaultValue: () => undefined },
);
const GrantedPod = Context.Reference<PodStanding | undefined>("sugabots/server/GrantedPod", {
	defaultValue: () => undefined,
});
const GrantedAgent = Context.Reference<AgentStanding | undefined>("sugabots/server/GrantedAgent", {
	defaultValue: () => undefined,
});

/** The workspace an endpoint's `{ workspace }` rule granted. */
export const grantedWorkspace: Effect.Effect<WorkspaceStanding> = granted(
	GrantedWorkspace,
	"workspace",
);
/** The pod an endpoint's `{ pod }` rule granted. */
export const grantedPod: Effect.Effect<PodStanding> = granted(GrantedPod, "pod");
/** The agent an endpoint's `{ agent }` rule granted. */
export const grantedAgent: Effect.Effect<AgentStanding> = granted(GrantedAgent, "agent");

function granted<Standing>(
	reference: Context.Reference<Standing | undefined>,
	scope: string,
): Effect.Effect<Standing> {
	return Effect.filterOrElse(
		Effect.service(reference),
		(standing) => standing !== undefined,
		() => Effect.die(new Error(`This endpoint's access rule grants no ${scope}`)),
	);
}

export function authoriseLayer(authorization: Authorization) {
	return Layer.effect(
		Authorise,
		Effect.gen(function* () {
			const database = yield* Effect.context<Database>();
			const decide = <Standing>(decision: Effect.Effect<Standing, AuthorizationDenied, Database>) =>
				decision.pipe(asHttpError(denials), Effect.provideContext(database));

			return (httpEffect, { group, endpoint }) =>
				Effect.gen(function* () {
					const rule = accessRuleFor(group.identifier, endpoint.identifier);
					if (rule === undefined) {
						return yield* Effect.die(
							new Error(`${endpoint.method} ${endpoint.path} has no rule in accessPolicy`),
						);
					}
					if ("reach" in rule) {
						return yield* httpEffect;
					}

					const { id: userId } = yield* CurrentUser;
					const { params } = yield* HttpRouter.RouteContext;
					if ("workspace" in rule) {
						const standing = yield* decide(
							authorization.workspace(userId, params.workspace ?? "", rule.workspace),
						);
						return yield* Effect.provideService(httpEffect, GrantedWorkspace, standing);
					}
					if ("pod" in rule) {
						const standing = yield* decide(authorization.pod(userId, params.podId ?? "", rule.pod));
						return yield* Effect.provideService(httpEffect, GrantedPod, standing);
					}
					const standing = yield* decide(
						authorization.agent(userId, params.agentId ?? "", rule.agent),
					);
					return yield* Effect.provideService(httpEffect, GrantedAgent, standing);
				});
		}),
	);
}

const denials = { ResourceHidden: NotFound, ActionForbidden: Forbidden };
