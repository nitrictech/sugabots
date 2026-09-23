import { MAX_IDEMPOTENCY_KEY_CHARACTERS } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { upcomingOccurrences } from "@sugabots/core/conversations/routines/schedule";
import type { RoutineStore } from "@sugabots/core/conversations/routines/store";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { bearerToken } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { grantedAgent } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface RoutineRoutesOptions {
	routines: RoutineStore;
}

export function routineRoutes({ routines }: RoutineRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "routines", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.flatMap(grantedAgent, ({ agent }) => routines.list(agent.workspaceId, agent.id)),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const { agent, actor } = yield* grantedAgent;
					return yield* routines
						.create(agent.workspaceId, agent.id, actor.userId, payload)
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
					const found = yield* routines.get(agent.workspaceId, agent.id, params.routineId);
					return found ?? (yield* noSuchRoutine);
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					routines
						.update(agent.workspaceId, agent.id, params.routineId, payload)
						.pipe(asHttpError(routineErrors)),
				),
			)
			.handle("remove", ({ params }) =>
				Effect.flatMap(grantedAgent, ({ agent }) =>
					routines
						.remove(agent.workspaceId, agent.id, params.routineId)
						.pipe(asHttpError(routineErrors)),
				),
			)
			.handle("run", ({ params, payload }) =>
				Effect.gen(function* () {
					const { agent, actor } = yield* grantedAgent;
					return yield* routines
						.acceptTrigger({
							workspaceId: agent.workspaceId,
							agentId: agent.id,
							routineId: params.routineId,
							triggerIdentity: payload.requestId,
							trigger: {
								kind: "manual",
								requestId: payload.requestId,
								requestedAt: new Date().toISOString(),
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
						.rotateSecret(agent.workspaceId, agent.id, params.routineId)
						.pipe(asHttpError(routineErrors));
					return { secret };
				}),
			)
			.handle("executions", ({ params, query }) =>
				Effect.gen(function* () {
					const { agent } = yield* grantedAgent;
					const executions = yield* routines
						.listExecutions(agent.workspaceId, agent.id, params.routineId, query)
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
					const accepted = secret
						? yield* routines
								.acceptWebhook(params.routineId, secret, {
									kind: "webhook",
									idempotencyKey,
									payload,
									receivedAt: new Date().toISOString(),
								})
								.pipe(asHttpError(routineErrors))
						: undefined;
					if (!accepted) {
						return yield* new Unauthorized({ message: "Invalid Routine webhook credentials" });
					}
					return { executionId: accepted.executionId, duplicate: accepted.duplicate };
				}),
			),
	);
}

function isJson(contentType: string | undefined): boolean {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

const noSuchRoutine = new NotFound({ message: "No such Routine" });

const routineErrors = {
	InvalidRoutineExecutionCursor: () =>
		new BadRequest({ message: "That Routine execution cursor is invalid" }),
	InvalidRoutineSchedule: (failure: { message: string }) =>
		new BadRequest({ message: failure.message }),
	RoutineNameTaken: () => new Conflict({ message: "A Routine with that name already exists" }),
	RoutineNotFound: () => noSuchRoutine,
	RoutineRequiresCrewAgent: () => new BadRequest({ message: "Only crew agents can own Routines" }),
	RoutineTriggerConflict: () =>
		new Conflict({ message: "That trigger identity was already used with different data" }),
	RoutineTriggerRejected: () =>
		new BadRequest({ message: "That Routine cannot accept this trigger" }),
};
