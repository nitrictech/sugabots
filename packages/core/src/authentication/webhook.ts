export { WebhookRefused } from "@sugabots/contracts/errors/automations";
export * as WebhookAuthentication from "./webhook.ts";

import { WebhookRefused } from "@sugabots/contracts/errors/automations";
import { and, eq, isNull } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { type Delivery, deliveryAuthentic } from "../chats/automations/webhook-auth.ts";
import { query, serviceOperations } from "../database/database.ts";
import { automation, automationTrigger, connector } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { authenticated, type WebhookCall } from "../principal.ts";
import { openAppCredential } from "../providers/connectors/github/credential.ts";
import * as GitHub from "../providers/connectors/github/github.ts";
import { Secrets } from "../secrets/secrets.ts";
import { processLayer, Tier } from "../tiers.ts";

/**
 * The authenticator for webhook calls: an automation's trigger, and a
 * project's GitHub app. Each checks the call against the secret stored for
 * what it is addressed to, and the principal it builds reaches only that.
 * A webhook trigger left without a secret is open to anyone with its address.
 *
 * Whether the call then does anything, such as whether its automation is on,
 * is the operation's to decide.
 */
export interface Interface {
	/** A call to the webhook trigger `triggerId`, checked as the trigger says. */
	readonly trigger: (
		triggerId: string,
		delivery: Delivery,
	) => Effect.Effect<WebhookCall, WebhookRefused>;
	/** A delivery to the GitHub app of the GitHub connector `connectorId`, checked against its webhook secret. */
	readonly github: (
		connectorId: string,
		delivery: GitHubDelivery,
	) => Effect.Effect<WebhookCall, WebhookRefused>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WebhookAuthentication",
) {
	declare readonly [Tier]: "process";
}

/** A delivery to a GitHub app, as it arrived. */
export interface GitHubDelivery {
	/** By lower-case name. */
	readonly headers: Readonly<Record<string, string | undefined>>;
	/** The body exactly as sent, since its signature is over it. */
	readonly body: string;
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("WebhookAuthentication");
	const secrets = yield* Secrets.Service;

	/** The webhook trigger `triggerId` of an automation not deleted, with how it checks callers. */
	const webhookTrigger = (triggerId: string) =>
		query((db) =>
			db
				.select({
					workspace: automation.workspaceId,
					project: automation.projectId,
					automation: automation.id,
					settings: automationTrigger.settings,
					secret: automationTrigger.secretEncrypted,
				})
				.from(automationTrigger)
				.innerJoin(automation, eq(automation.id, automationTrigger.automationId))
				.where(
					and(
						eq(automationTrigger.id, triggerId),
						eq(automationTrigger.kind, "webhook"),
						isNull(automation.deletedAt),
					),
				)
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	return Service.of({
		trigger: (triggerId, delivery) =>
			operation(
				"trigger",
				Effect.gen(function* () {
					const found = isUuid(triggerId) ? yield* webhookTrigger(triggerId) : undefined;
					if (found?.settings.kind !== "webhook") return yield* new WebhookRefused();
					// Left without a secret on purpose, so its address alone calls it.
					const authentic =
						found.secret === null ||
						deliveryAuthentic(
							found.settings.auth,
							secrets.decrypt(found.secret),
							delivery,
							yield* DateTime.nowAsDate,
						);
					if (!authentic) return yield* new WebhookRefused();
					return authenticated.webhookCall({
						workspace: found.workspace,
						source: {
							kind: "trigger",
							trigger: triggerId,
							automation: found.automation,
							project: found.project,
						},
					});
				}),
			),

		github: (connectorId, delivery) =>
			operation(
				"github",
				Effect.gen(function* () {
					const [row] = isUuid(connectorId)
						? yield* query((db) =>
								db
									.select({
										workspace: connector.workspaceId,
										project: connector.projectId,
										sealed: connector.appCredentialEncrypted,
									})
									.from(connector)
									.where(and(eq(connector.id, connectorId), eq(connector.kind, "github")))
									.limit(1),
							)
						: [];
					const secret = row?.sealed && openAppCredential(secrets, row.sealed).webhookSecret;
					if (
						!row ||
						!secret ||
						!GitHub.signedDelivery(secret, delivery.body, delivery.headers["x-hub-signature-256"])
					) {
						return yield* new WebhookRefused();
					}
					return authenticated.webhookCall({
						workspace: row.workspace,
						source: { kind: "github", connector: connectorId, project: row.project },
					});
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;
