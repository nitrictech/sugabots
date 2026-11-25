import { BadRequest, Conflict, Forbidden, NotFound, Unauthorized } from "@sugabots/contracts/http";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { Ids } from "@sugabots/core/ids/ids";
import type { Call } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import { userText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";
import { isJson } from "../../http/validation.ts";

/**
 * A project's automations, each endpoint its operation, and the webhook that
 * starts one's run. The webhook has no session: core's webhook authenticator
 * checks the call against its trigger's secret, and the operation is called
 * for the principal that makes.
 */
export const automationRoutes = HttpApiBuilder.group(ServerApi, "automations", (handlers) =>
	Effect.gen(function* () {
		const callOperation = yield* operationCaller;
		const operations = yield* Operations.Service;
		const webhooks = yield* WebhookAuthentication.Service;
		const ids = yield* Ids.Service;

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
				const { headers } = request;
				const principal = yield* webhooks.trigger(triggerId, { headers, body, payload });
				const call: Call = { kind: "request", request: yield* ids.next };
				return yield* operations["automations.webhook"](
					principal,
					{ triggerId, headers, payload },
					call,
				);
			}).pipe(asHttpError(webhookErrors));

		return (
			handlers
				.handle("list", ({ params }) =>
					callOperation("automations.list", params).pipe(asHttpError(automationErrors)),
				)
				.handle("create", ({ params, payload }) =>
					callOperation("automations.create", { ...params, ...payload }).pipe(
						asHttpError(automationErrors),
					),
				)
				.handle("update", ({ params, payload }) =>
					callOperation("automations.update", { ...params, changes: payload }).pipe(
						asHttpError(automationErrors),
					),
				)
				.handle("remove", ({ params }) =>
					callOperation("automations.remove", params).pipe(asHttpError(automationErrors)),
				)
				.handle("run", ({ params, payload }) =>
					callOperation("automations.run", { ...params, requestId: payload.requestId }).pipe(
						asHttpError(automationErrors),
						Effect.asVoid,
					),
				)
				.handle("addTrigger", ({ params, payload }) =>
					callOperation("automations.addTrigger", { ...params, trigger: payload }).pipe(
						asHttpError(automationErrors),
					),
				)
				.handle("updateTrigger", ({ params, payload }) =>
					callOperation("automations.updateTrigger", { ...params, trigger: payload }).pipe(
						asHttpError(automationErrors),
					),
				)
				.handle("removeTrigger", ({ params }) =>
					callOperation("automations.removeTrigger", params).pipe(asHttpError(automationErrors)),
				)
				.handle("getSecret", ({ params }) =>
					callOperation("automations.getSecret", params).pipe(asHttpError(automationErrors)),
				)
				.handle("rotateSecret", ({ params, payload }) =>
					callOperation("automations.rotateSecret", { ...params, secret: payload.secret }).pipe(
						asHttpError(automationErrors),
					),
				)
				.handle("projectRuns", ({ params, query }) =>
					callOperation("automations.projectRuns", { ...params, ...query }).pipe(
						asHttpError(automationErrors),
					),
				)
				// Raw, so a body that is not JSON is refused with the reason rather
				// than the generic unsupported-content-type answer.
				.handleRaw("webhook", ({ params, request }) => receive(params.triggerId, request))
		);
	}),
);

/** What each way an automations operation can fail means over HTTP. */
const automationErrors = {
	...refusals,
	ApprovalNeeded: Forbidden,
	ApprovalRefused: Forbidden,
	InvalidCursor: BadRequest,
	InvalidRoutineSchedule: BadRequest,
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

/**
 * What each way a webhook call can fail means to its caller. A call the
 * trigger's secret doesn't authenticate, or to no running automation's
 * webhook, is told the same, so an address can't be probed for.
 */
const webhookErrors = {
	WebhookRefused: Unauthorized,
	AutomationTriggerConflict: Conflict,
	AutomationTriggerRejected: BadRequest,
	AutomationDeliveryIdTooLong: BadRequest,
};
