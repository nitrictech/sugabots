import { BadRequest, Conflict, Unauthorized } from "@sugabots/contracts/http";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import type { Call } from "@sugabots/core/operations/operation";
import { Operations } from "@sugabots/core/operations/registry";
import { userText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { asHttpError } from "../../http/errors.ts";
import { isJson } from "../../http/validation.ts";

/**
 * The webhooks entrypoint: an automation's trigger, and a GitHub connector's
 * app delivering events. Neither has a session: core's webhook authenticator
 * admits a call by its secret, over the body exactly as sent, and its
 * operation is called for the principal that makes. Each handler is raw,
 * since a signature covers the body as sent.
 */
export const webhookRoutes = HttpApiBuilder.group(ServerApi, "webhooks", (handlers) =>
	Effect.gen(function* () {
		const operations = yield* Operations.Service;
		const webhooks = yield* WebhookAuthentication.Service;
		const call: Call = { kind: "request" };
		return (
			handlers
				// A body that is not JSON is refused with the reason rather than the
				// generic unsupported-content-type answer.
				.handleRaw("trigger", ({ params, request }) =>
					Effect.gen(function* () {
						if (!isJson(request.headers["content-type"])) {
							return yield* new BadRequest({
								message: userText`Automation webhooks require a JSON content type`,
							});
						}
						const invalid = () =>
							new BadRequest({ message: userText`That is not a valid request` });
						// The size check has read the body as text already. JSON is UTF-8,
						// so encoding it again gives the bytes as sent, which a signature covers.
						const text = yield* Effect.mapError(request.text, invalid);
						const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
							text,
						).pipe(Effect.mapError(invalid));
						const body = new TextEncoder().encode(text);
						const { headers } = request;
						const principal = yield* webhooks.trigger(params.triggerId, {
							headers,
							body,
							payload,
						});
						return yield* operations["automations.webhook"](
							principal,
							{ triggerId: params.triggerId, headers, payload },
							call,
						);
					}).pipe(asHttpError(triggerErrors)),
				)
				.handleRaw("gitHubDelivery", ({ params, request }) =>
					Effect.gen(function* () {
						// Answered alike, so a connector's address can't be probed for.
						const refused = () =>
							new Unauthorized({ message: userText`That delivery isn't signed by its app` });
						const body = yield* Effect.mapError(request.text, refused);
						const { headers } = request;
						const principal = yield* webhooks
							.github(params.connectorId, { headers, body })
							.pipe(Effect.mapError(refused));
						yield* operations["gitHubWebhooks.delivery"](
							principal,
							{
								connectorId: params.connectorId,
								event: headers["x-github-event"],
								deliveryId: headers["x-github-delivery"],
								body,
							},
							call,
						).pipe(
							Effect.mapError((error) =>
								error._tag === "GitHubDeliveryIdInvalid"
									? new BadRequest({ message: error.userMessage })
									: refused(),
							),
						);
						return HttpServerResponse.empty({ status: 204 });
					}),
				)
		);
	}),
);

/**
 * What each way a trigger's call can fail means to its caller. A call the
 * trigger's secret doesn't authenticate, or to no running automation's
 * webhook, is told the same, so an address can't be probed for.
 */
const triggerErrors = {
	WebhookRefused: Unauthorized,
	AutomationTriggerConflict: Conflict,
	AutomationTriggerRejected: BadRequest,
	AutomationDeliveryIdTooLong: BadRequest,
};
