import { BadRequest, Conflict, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { Automations } from "@sugabots/core/chats/automations/automations";
import { userText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { isJson } from "../../http/validation.ts";

export const automationRoutes = HttpApiBuilder.group(ServerApi, "automations", (handlers) =>
	Effect.gen(function* () {
		const automations = yield* Automations.Service;
		const webhooks = yield* Automations.Webhooks;
		const receive = (triggerId: string, request: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				if (!isJson(request.headers["content-type"])) {
					return yield* new BadRequest({
						message: userText`Automation webhooks require a JSON content type`,
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
					.pipe(asHttpError(automationErrors));
				if (!accepted) {
					return yield* new Unauthorized({
						message: userText`Invalid automation webhook credentials`,
					});
				}
				if (accepted.kind === "ignored") return { ignored: true as const };
				if (accepted.kind === "challenge") return { challenge: accepted.challenge };
				const { runId, duplicate } = accepted.run;
				return { runId, duplicate };
			});
		return (
			handlers
				.handle("list", ({ params }) =>
					automations.list(params).pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("create", ({ params, payload }) =>
					automations.create(params, payload).pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("update", ({ params, payload }) =>
					automations.update(params, payload).pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("remove", ({ params }) =>
					automations.remove(params).pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("run", ({ params, payload }) =>
					automations
						.run({ ...params, requestId: payload.requestId })
						.pipe(asCurrentUser, asHttpError(automationErrors), Effect.asVoid),
				)
				.handle("addTrigger", ({ params, payload }) =>
					automations
						.addTrigger(params, payload)
						.pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("updateTrigger", ({ params, payload }) =>
					automations
						.updateTrigger(params, payload)
						.pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("removeTrigger", ({ params }) =>
					automations.removeTrigger(params).pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("getSecret", ({ params }) =>
					automations.getSecret(params).pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				.handle("rotateSecret", ({ params, payload }) =>
					automations.rotateSecret(params, payload.secret).pipe(
						Effect.map((secret) => ({ secret })),
						asCurrentUser,
						asHttpError(automationErrors),
					),
				)
				.handle("projectRuns", ({ params, query }) =>
					automations
						.listProjectRuns(params, query)
						.pipe(asCurrentUser, asHttpError(automationErrors)),
				)
				// Raw, so a body that is not JSON is refused with the reason rather
				// than the generic unsupported-content-type answer.
				.handleRaw("webhook", ({ params, request }) => receive(params.triggerId, request))
		);
	}),
);

const automationErrors = {
	...refusals,
	InvalidCursor: BadRequest,
	InvalidRoutineSchedule: BadRequest,
	AutomationDeliveryIdTooLong: BadRequest,
	AutomationNameTaken: Conflict,
	AutomationNotFound: NotFound,
	AutomationRepositoryNotConnected: BadRequest,
	AutomationTriggerConflict: Conflict,
	AutomationTriggerKindChanged: BadRequest,
	AutomationTriggerNotFound: NotFound,
	AutomationTriggerRejected: BadRequest,
	TooManyAutomationTriggers: Conflict,
	WebhookSecretTooShort: BadRequest,
	WebhookDeliveryIdHeaderRejected: BadRequest,
};
