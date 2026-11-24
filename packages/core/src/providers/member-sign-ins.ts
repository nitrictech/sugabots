export * as MemberSignIns from "./member-sign-ins.ts";

import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Duration, Effect, ErrorReporter, Layer, Schedule, Schema } from "effect";
import { afterCommit, query, serviceOperations } from "../database/database.ts";
import { member } from "../database/schema.ts";
import { Secrets } from "../secrets/secrets.ts";
import { ConnectorStore } from "./connectors/connector-store.ts";
import { openAppCredential } from "./connectors/github/credential.ts";
import * as GitHub from "./connectors/github/github.ts";
import { providersSignedInAs } from "./model-providers/model-provider-reads.ts";
import { Egress } from "./network/egress.ts";

/**
 * What in a workspace signs in as one member: the OAuth sign-ins they made for
 * its connectors, their subscription sign-ins for its model providers, and
 * the GitHub apps they installed on their own GitHub account. Each is theirs
 * alone, so none outlasts their place in the workspace. A key someone entered
 * isn't theirs alone, so it stays.
 *
 * A model provider is never signed out on their way out: bots and the
 * workspace's default model run on it, so while one signs in with their
 * subscription, they stay.
 */
export interface Interface {
	/**
	 * For a member going from the workspace, under its membership lock in the
	 * transaction that takes their membership away. Fails with
	 * `SubscriptionInUse`, changing nothing, while any of its model providers
	 * signs in with their subscription. Otherwise signs out the connectors they
	 * signed in, so each shows as needing to be signed in again, and forgets
	 * the GitHub apps they installed on their own GitHub account, so each
	 * project must install its app again.
	 * Each installation is uninstalled at GitHub once the enclosing transaction
	 * commits, in the background, trying again while GitHub can't be reached.
	 */
	readonly forget: (departing: {
		workspaceId: string;
		memberId: string;
	}) => Effect.Effect<void, SubscriptionInUse>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/MemberSignIns",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("MemberSignIns");
	const connectors = yield* ConnectorStore.Service;
	const secrets = yield* Secrets.Service;
	const egress = yield* Egress.Service;
	// Uninstalling outlives the transaction that asked for it, and its retries must not hold up the removal.
	const uninstalling = yield* Effect.scope;

	const uninstall = (installation: ConnectorStore.ForgottenInstallation) =>
		Effect.gen(function* () {
			const { privateKey } = openAppCredential(secrets, installation.appCredentialEncrypted);
			yield* GitHub.uninstall(
				egress.providers.for({ baseUrl: GitHub.API_URL }),
				{ appId: installation.appId, privateKey },
				installation.installationId,
			).pipe(
				Effect.retry({ while: (failure) => failure.isRetryable, schedule: UNINSTALL_RETRIES }),
			);
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logError(
					"A forgotten GitHub app installation wasn't uninstalled; uninstall it on GitHub",
					cause,
				),
			),
			Effect.annotateLogs({
				connectorId: installation.connectorId,
				appId: installation.appId,
				installationId: installation.installationId,
			}),
			Effect.forkIn(uninstalling),
			Effect.asVoid,
		);

	return Service.of({
		forget: ({ workspaceId, memberId }) =>
			operation(
				"forget",
				Effect.gen(function* () {
					const signedIn = yield* providersSignedInAs(workspaceId, memberId);
					if (signedIn.length > 0) {
						return yield* new SubscriptionInUse({
							member: yield* nameOf(memberId),
							providers: signedIn,
						});
					}
					yield* connectors.signOutSignedInBy(workspaceId, memberId);
					const installations = yield* connectors.forgetGitHubInstallationsBy(
						workspaceId,
						memberId,
					);
					yield* Effect.forEach(
						installations,
						(installation) => afterCommit(uninstall(installation)),
						{ discard: true },
					);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ConnectorStore.layer));

/**
 * Model providers sign in with the subscription of a member being removed
 * from the workspace, or leaving it. Signing them out would stop the bots and
 * the default model that run on them, so the member stays until each is
 * signed in by another member or switched to a key.
 */
export class SubscriptionInUse
	extends Schema.TaggedError<SubscriptionInUse>()("SubscriptionInUse", {
		member: DisplayName.schema,
		/** In the order the workspace's list of model providers shows them. */
		providers: Schema.Array(DisplayName.schema),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `${this.member} stays in the workspace: ${LIST.format(this.providers)} sign in with their subscription`;
	}
	get userMessage() {
		const one = this.providers.length === 1;
		// A list of names members see is itself a name they see.
		const names = DisplayName.fromRecord(LIST.format(this.providers));
		return userText`${names} ${one ? "signs" : "sign"} in with ${this.member}'s subscription, so ${this.member} stays until another member signs ${one ? "it" : "them"} in or ${one ? "it's" : "they're"} switched to a key.`;
	}
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

const nameOf = (memberId: string) =>
	query((db) => db.select({ name: member.name }).from(member).where(eq(member.id, memberId))).pipe(
		Effect.flatMap(([found]) =>
			found
				? Effect.succeed(DisplayName.fromRecord(found.name))
				: Effect.die(new Error("The member going from the workspace is missing")),
		),
	);

/**
 * Up to ten more attempts after the first, the first of them a second later
 * and each after that twice as long after the one before: about seventeen
 * minutes in all, to ride out GitHub being unreachable for a while.
 */
const UNINSTALL_RETRIES = Schedule.exponential(Duration.seconds(1)).pipe(
	Schedule.upTo({ times: 10 }),
);
