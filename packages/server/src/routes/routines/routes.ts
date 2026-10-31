import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { userText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const routineRoutes = HttpApiBuilder.group(ServerApi, "routines", (handlers) =>
	Effect.gen(function* () {
		const routines = yield* Routines.Service;
		const webhooks = yield* Routines.Webhooks;
		const receive = (triggerId: string, request: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				if (!isJson(request.headers["content-type"])) {
					return yield* new BadRequest({
						message: userText`Routine webhooks require a JSON content type`,
					});
				}
				const invalid = () => new BadRequest({ message: userText`That is not a valid request` });
				// The size check has read the body as text already. JSON is UTF-8,
				// so encoding it again gives the bytes as sent, which a signature covers.
				const text = yield* Effect.mapError(request.text, invalid);
				const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
					text,
				).pipe(Effect.mapError(invalid));
				const body = new TextEncoder().encode(text);
				// Deliberately without a session: proving it holds the trigger's secret is what admits the run.
				const accepted = yield* webhooks
					.accept({ triggerId, delivery: { headers: request.headers, body, payload } })
					.pipe(asHttpError(routineErrors));
				if (!accepted) {
					return yield* new Unauthorized({
						message: userText`Invalid Routine webhook credentials`,
					});
				}
				if (accepted.kind === "challenge") return { challenge: accepted.challenge };
				const { executionId, duplicate } = accepted.execution;
				return { executionId, duplicate };
			});
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
				.handle("addTrigger", ({ params, payload }) =>
					routines.addTrigger(params, payload).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("updateTrigger", ({ params, payload }) =>
					routines.updateTrigger(params, payload).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("removeTrigger", ({ params }) =>
					routines.removeTrigger(params).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("getSecret", ({ params }) =>
					routines.getSecret(params).pipe(asSessionUser, asHttpError(routineErrors)),
				)
				.handle("rotateSecret", ({ params, payload }) =>
					routines.rotateSecret(params, payload.secret).pipe(
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
				.handleRaw("webhook", ({ params, request }) => receive(params.triggerId, request))
				// A trigger moved from a routine's single trigger has the routine's id.
				.handleRaw("routineWebhook", ({ params, request }) => receive(params.routineId, request))
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
	RoutineDeliveryIdTooLong: BadRequest,
	RoutineChatNotFound: BadRequest,
	RoutineNameTaken: Conflict,
	RoutineNotFound: NotFound,
	RoutineRepositoryNotInPod: BadRequest,
	RoutineTriggerConflict: Conflict,
	RoutineTriggerKindChanged: BadRequest,
	RoutineTriggerNotFound: NotFound,
	RoutineTriggerRejected: BadRequest,
	TooManyRoutineTriggers: Conflict,
	WebhookSecretTooShort: BadRequest,
	WebhookDeliveryIdHeaderRejected: BadRequest,
};
