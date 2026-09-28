import { MAX_IDEMPOTENCY_KEY_CHARACTERS } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { RoutineView } from "@sugabots/core/conversations/routines/routine-view";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { upcomingOccurrences } from "@sugabots/core/conversations/routines/schedule";
import { DateTime, Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { bearerToken } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { grantedAgent, grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export const routineRoutes = HttpApiBuilder.group(ServerApi, "routines", (handlers) =>
	Effect.gen(function* () {
		const routines = yield* Routines.Service;
		const view = yield* RoutineView.Service;
		return (
			handlers
				.handle("listInWorkspace", () =>
					Effect.gen(function* () {
						const { workspaceId, actor } = yield* grantedWorkspace;
						const items = yield* view.listInWorkspace(workspaceId, actor.userId);
						return { items };
					}),
				)
				.handle("list", () =>
					Effect.flatMap(grantedAgent, ({ agent }) =>
						view.list({ workspaceId: agent.workspaceId, agentId: agent.id }),
					),
				)
				.handle("create", ({ payload }) =>
					Effect.gen(function* () {
						const { agent, actor } = yield* grantedAgent;
						return yield* routines
							.create(
								{ workspaceId: agent.workspaceId, agentId: agent.id, createdById: actor.userId },
								payload,
							)
							.pipe(asHttpError(routineErrors));
					}),
				)
				.handle("previewSchedule", ({ payload }) =>
					upcomingOccurrences(payload.expression, payload.timezone).pipe(
						Effect.map((dates) => dates.map((date) => date.toISOString())),
						asHttpError(routineErrors),
					),
				)
				.handle("get", ({ params }) =>
					Effect.gen(function* () {
						const { agent } = yield* grantedAgent;
						const found = yield* view.get(scopeOf(agent, params.routineId));
						return found ?? (yield* noSuchRoutine);
					}),
				)
				.handle("update", ({ params, payload }) =>
					Effect.flatMap(grantedAgent, ({ agent }) =>
						routines
							.update(scopeOf(agent, params.routineId), payload)
							.pipe(asHttpError(routineErrors)),
					),
				)
				.handle("remove", ({ params }) =>
					Effect.flatMap(grantedAgent, ({ agent }) =>
						routines.remove(scopeOf(agent, params.routineId)).pipe(asHttpError(routineErrors)),
					),
				)
				.handle("run", ({ params, payload }) =>
					Effect.gen(function* () {
						const { agent, actor } = yield* grantedAgent;
						const requestedAt = DateTime.formatIso(yield* DateTime.now);
						return yield* routines
							.acceptTrigger({
								...scopeOf(agent, params.routineId),
								triggerIdentity: payload.requestId,
								trigger: {
									kind: "manual",
									requestId: payload.requestId,
									requestedAt,
									requestedByUserId: actor.userId,
								},
							})
							.pipe(asHttpError(routineErrors));
					}),
				)
				.handle("rotateSecret", ({ params }) =>
					Effect.gen(function* () {
						const { agent } = yield* grantedAgent;
						const secret = yield* routines
							.rotateSecret(scopeOf(agent, params.routineId))
							.pipe(asHttpError(routineErrors));
						return { secret };
					}),
				)
				.handle("executions", ({ params, query }) =>
					Effect.gen(function* () {
						const { agent } = yield* grantedAgent;
						const executions = yield* view
							.listExecutions(scopeOf(agent, params.routineId), query)
							.pipe(asHttpError(routineErrors));
						return executions ?? (yield* noSuchRoutine);
					}),
				)
				// Raw, so a body that is not JSON is refused with the reason rather
				// than the generic unsupported-content-type answer.
				.handleRaw("webhook", ({ params, request }) =>
					Effect.gen(function* () {
						if (!isJson(request.headers["content-type"])) {
							return yield* new BadRequest({
								message: "Routine webhooks require a JSON content type",
							});
						}
						const payload = yield* request.text.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
							Effect.mapError(() => new BadRequest({ message: "That is not a valid request" })),
						);
						const idempotencyKey = request.headers["idempotency-key"]?.trim() || null;
						if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARACTERS) {
							return yield* new BadRequest({ message: "Idempotency-Key is too long" });
						}
						const secret = bearerToken(request.headers.authorization);
						const receivedAt = DateTime.formatIso(yield* DateTime.now);
						const accepted = secret
							? yield* routines
									.acceptWebhook(params.routineId, secret, {
										kind: "webhook",
										idempotencyKey,
										payload,
										receivedAt,
									})
									.pipe(asHttpError(routineErrors))
							: undefined;
						if (!accepted) {
							return yield* new Unauthorized({ message: "Invalid Routine webhook credentials" });
						}
						return { executionId: accepted.executionId, duplicate: accepted.duplicate };
					}),
				)
		);
	}),
);

/** The routine `routineId` on the agent the route was granted. */
function scopeOf(agent: { workspaceId: string; id: string }, routineId: string) {
	return { workspaceId: agent.workspaceId, agentId: agent.id, routineId };
}

function isJson(contentType: string | undefined): boolean {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

const noSuchRoutine = new NotFound({ message: "No such Routine" });

const routineErrors = {
	InvalidRoutineExecutionCursor: BadRequest,
	InvalidRoutineSchedule: BadRequest,
	RoutineNameTaken: Conflict,
	RoutineNotFound: NotFound,
	RoutineRequiresCrewAgent: BadRequest,
	RoutineTriggerConflict: Conflict,
	RoutineTriggerRejected: BadRequest,
};
