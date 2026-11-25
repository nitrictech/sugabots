export { SubscriptionInUse } from "@sugabots/contracts/errors/workspace";
export * as MemberSignIns from "./member-sign-ins.ts";

import { SubscriptionInUse } from "@sugabots/contracts/errors/workspace";
import { DisplayName } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { query, serviceOperations, Transaction } from "../database/database.ts";
import { member } from "../database/schema.ts";
import { processLayer, Tier } from "../tiers.ts";
import { ConnectorStore } from "./connectors/connector-store.ts";
import { GitHubUninstalls } from "./connectors/github/uninstalls.ts";
import { providersSignedInAs } from "./model-providers/model-provider-reads.ts";

interface DepartingMember {
	readonly workspaceId: string;
	readonly memberId: string;
}

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
	 * Each installation is queued for the scheduler to uninstall after the
	 * enclosing transaction commits.
	 */
	readonly forget: (
		departing: DepartingMember,
	) => Effect.Effect<void, SubscriptionInUse, Transaction>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/MemberSignIns") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("MemberSignIns");
	const connectors = yield* ConnectorStore.Service;
	const uninstalls = yield* GitHubUninstalls.Service;

	const requireNoSubscription = ({ workspaceId, memberId }: DepartingMember) =>
		Effect.gen(function* () {
			yield* Transaction;
			const signedIn = yield* providersSignedInAs(workspaceId, memberId);
			if (signedIn.length > 0) {
				return yield* new SubscriptionInUse({
					member: yield* nameOf(memberId),
					providers: signedIn,
				});
			}
		});

	return Service.of({
		forget: ({ workspaceId, memberId }) =>
			operation(
				"forget",
				Effect.gen(function* () {
					yield* requireNoSubscription({ workspaceId, memberId });
					yield* connectors.signOutSignedInBy(workspaceId, memberId);
					const installations = yield* connectors.forgetGitHubInstallationsBy(
						workspaceId,
						memberId,
					);
					yield* uninstalls.enqueue(workspaceId, installations);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectorStore.layer, GitHubUninstalls.layer]),
);

const nameOf = (memberId: string) =>
	query((db) => db.select({ name: member.name }).from(member).where(eq(member.id, memberId))).pipe(
		Effect.flatMap(([found]) =>
			found
				? Effect.succeed(DisplayName.fromRecord(found.name))
				: Effect.die(new Error("The member going from the workspace is missing")),
		),
	);
