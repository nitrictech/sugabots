import { Access, Authorise, CurrentUser, Forbidden, NotFound } from "@sugabots/contracts/http";
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
import { asHttpError } from "./errors.ts";

/**
 * The `Authorise` middleware: each endpoint's `Access` rule, checked against
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
	return Effect.flatMap(Effect.service(reference), (standing) =>
		standing === undefined
			? Effect.die(new Error(`This endpoint's Access rule grants no ${scope}`))
			: Effect.succeed(standing),
	);
}

export function authoriseLayer(authorization: Authorization) {
	return Layer.effect(
		Authorise,
		Effect.gen(function* () {
			const database = yield* Effect.context<Database>();
			const decide = <Standing>(decision: Effect.Effect<Standing, AuthorizationDenied, Database>) =>
				decision.pipe(asHttpError(denials), Effect.provideContext(database));

			return (httpEffect, { endpoint }) =>
				Effect.gen(function* () {
					const rule = Context.getOrUndefined(endpoint.annotations, Access);
					if (rule === undefined) {
						return yield* Effect.die(
							new Error(`${endpoint.method} ${endpoint.path} declares no Access rule`),
						);
					}
					if ("reach" in rule) {
						return yield* httpEffect;
					}

					const { id: userId } = yield* CurrentUser;
					const { params } = yield* HttpRouter.RouteContext;
					if ("workspace" in rule) {
						const standing = yield* decide(
							authorization.workspace(userId, params.workspaceId ?? "", rule.workspace),
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

const denials = {
	ResourceHidden: (hidden: { message: string }) => new NotFound({ message: hidden.message }),
	ActionForbidden: () => new Forbidden({ message: "You are not allowed to do that" }),
};
