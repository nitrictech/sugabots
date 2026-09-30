import { MAX_IDEMPOTENCY_KEY_CHARACTERS } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { DateTime, Effect, Redacted, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser, bearerToken } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const routineRoutes = HttpApiBuilder.group(ServerApi, "routines", (handlers) =>
	Effect.gen(function* () {
		const routines = yield* Routines.Service;
		const webhooks = yield* Routines.Webhooks;
		return (
			handlers
				.handle("listInWorkspace", ({ params }) =>
					routines.listInWorkspace(params.workspace).pipe(
						Effect.map((items) => ({ items })),
						asSessionUser,
						asHttpError(routineErrors),
					),
				)
				.handle("list", ({ params }) =>
					routines.list(params).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("create", ({ params, payload }) =>
					routines.create(params, payload).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("previewSchedule", ({ params, payload }) =>
					routines.previewSchedule({ agentId: params.agentId, ...payload }).pipe(
						Effect.map((dates) => dates.map((date) => date.toISOString())),
						asSessionUser,
						asHttpError(routineErrors),
					),
				)
				.handle("get", ({ params }) =>
					routines.get(params).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("update", ({ params, payload }) =>
					routines.update(params, payload).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("remove", ({ params }) =>
					routines.remove(params).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("run", ({ params, payload }) =>
					routines
						.run({ ...params, requestId: payload.requestId })
						.pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("rotateSecret", ({ params }) =>
					routines.rotateSecret(params).pipe(
						Effect.map((secret) => ({ secret })),
						asSessionUser,
						asHttpError(routineErrors),
					),
				)
				.handle("executions", ({ params, query }) =>
					routines.listExecutions(params, query).pipe(asSessionUser, asHttpError(routineErrors)),
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
						// Deliberately without a session: the routine's secret is what admits the run.
						const accepted = secret
							? yield* webhooks
									.accept({
										routineId: params.routineId,
										secret: Redacted.make(secret),
										trigger: { kind: "webhook", idempotencyKey, payload, receivedAt },
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

function isJson(contentType: string | undefined): boolean {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

const routineErrors = {
	...refusals,
	InvalidRoutineExecutionCursor: BadRequest,
	InvalidRoutineSchedule: BadRequest,
	RoutineNameTaken: Conflict,
	RoutineNotFound: NotFound,
	RoutineTriggerConflict: Conflict,
	RoutineTriggerRejected: BadRequest,
};
