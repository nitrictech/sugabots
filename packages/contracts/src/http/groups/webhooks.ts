import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedAutomationWebhookSchema,
	automationWebhookChallengeSchema,
	ignoredAutomationWebhookSchema,
} from "../../automations.ts";
import { GITHUB_WEBHOOK_PATH } from "../../github.ts";
import { uuidOrStringSchema, uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, Unauthorized } from "../errors.ts";
import {
	AUTOMATION_WEBHOOK_MAX_BODY_BYTES,
	GITHUB_DELIVERY_MAX_BODY_BYTES,
	MaxBodyBytes,
} from "../middleware.ts";
import { Entrypoint } from "../served.ts";

/** A run queued, a call its trigger's filter turned away, or Slack's address check. */
const triggerAnswers = [
	acceptedAutomationWebhookSchema.pipe(HttpApiSchema.status(202)),
	ignoredAutomationWebhookSchema,
	automationWebhookChallengeSchema,
];

/**
 * The webhooks entrypoint: calls from other systems, with no session. Each is
 * admitted by a secret over the body exactly as sent, so the call's operation
 * runs for the principal core's webhook authenticator makes.
 */
export class WebhooksApi extends HttpApiGroup.make("webhooks")
	.add(
		// Any JSON body, carried to the automation as its trigger's payload. The
		// caller proves it holds the trigger's secret the way the trigger's auth
		// says. A delivery id, such as `Idempotency-Key`, makes a retry land on
		// the run the first delivery started. Slack's URL check is answered
		// with its challenge, and starts nothing.
		HttpApiEndpoint.post("trigger", "/webhooks/triggers/:triggerId", {
			params: { triggerId: uuidOrStringSchema },
			payload: Schema.Json,
			success: triggerAnswers,
			error: [BadRequest, Unauthorized, Conflict],
		}).annotate(MaxBodyBytes, AUTOMATION_WEBHOOK_MAX_BODY_BYTES),
		/** Where a GitHub connector's app delivers events, signed under the app's webhook secret. */
		HttpApiEndpoint.post("gitHubDelivery", `${GITHUB_WEBHOOK_PATH}/:connectorId`, {
			params: { connectorId: uuidSchema },
			payload: Schema.Json,
			success: HttpApiSchema.Empty(204),
			error: [BadRequest, Unauthorized],
		}).annotate(MaxBodyBytes, GITHUB_DELIVERY_MAX_BODY_BYTES),
	)
	.annotate(
		Entrypoint,
		"Webhooks: each call is admitted by its secret, and starts its operation, held back from the HTTP API, for the principal core's webhook authenticator makes.",
	) {}
