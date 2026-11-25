export * as GitHubUninstalls from "./uninstalls.ts";

import { and, asc, eq, lte } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer } from "effect";
import { query, serviceOperations, Transaction, transaction } from "../../../database/database.ts";
import { gitHubUninstall } from "../../../database/schema.ts";
import type { DoesStoredWork } from "../../../proofs/does-stored-work.ts";
import { Secrets } from "../../../secrets/secrets.ts";
import { processLayer, Tier } from "../../../tiers.ts";
import { Egress } from "../../network/egress.ts";
import type { ConnectorStore } from "../connector-store.ts";
import { openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";

export interface Interface {
	readonly enqueue: (
		workspaceId: string,
		installations: readonly ConnectorStore.ForgottenInstallation[],
	) => Effect.Effect<void, never, Transaction>;
	readonly uninstall: <P, I>(work: DoesStoredWork<P, I, "gitHubUninstall">) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/GitHubUninstalls",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubUninstalls");
	const secrets = yield* Secrets.Service;
	const egress = yield* Egress.Service;

	return Service.of({
		enqueue: (workspaceId, installations) =>
			operation(
				"enqueue",
				Effect.gen(function* () {
					yield* Transaction;
					if (installations.length === 0) return;
					const nextAttemptAt = yield* DateTime.nowAsDate;
					yield* query((db) =>
						db.insert(gitHubUninstall).values(
							installations.map((installation) => ({
								...installation,
								workspaceId,
								nextAttemptAt,
							})),
						),
					);
				}),
			),

		uninstall: (proof) =>
			operation(
				"uninstall",
				transaction(
					Effect.gen(function* () {
						const now = yield* DateTime.nowAsDate;
						const [work] = yield* query((db) =>
							db
								.select()
								.from(gitHubUninstall)
								.where(
									and(isDue(now, proof.id.value), eq(gitHubUninstall.workspaceId, proof.workspace)),
								)
								.for("update", { skipLocked: true }),
						);
						if (!work) return;
						const { appId, installationId, connectorId } = work;
						const uninstall = Effect.suspend(() => {
							const { privateKey } = openAppCredential(secrets, work.appCredentialEncrypted);
							return GitHub.uninstall(
								egress.providers.for({ baseUrl: GitHub.API_URL }),
								{ appId, privateKey },
								installationId,
							);
						});
						const logUninstallError = (error: unknown) =>
							Effect.logError(
								"A forgotten GitHub app installation wasn't uninstalled; uninstall it on GitHub",
								error,
							).pipe(Effect.annotateLogs({ connectorId, appId, installationId }));
						const result = yield* uninstall.pipe(
							Effect.timeoutOrElse({
								duration: UNINSTALL_TIMEOUT,
								orElse: () =>
									Effect.fail(
										new GitHub.GitHubRequestFailed({
											status: undefined,
											reason: "Uninstall timed out",
										}),
									),
							}),
							Effect.catchDefect(logUninstallError),
							Effect.result,
						);
						if (result._tag === "Failure") {
							if (result.failure.isRetryable && work.attempts < UNINSTALL_RETRIES) {
								const endedAt = yield* DateTime.now;
								const retryAfter = Duration.seconds(2 ** work.attempts);
								const nextAttemptAt = DateTime.toDateUtc(DateTime.addDuration(endedAt, retryAfter));
								yield* query((db) =>
									db
										.update(gitHubUninstall)
										.set({ attempts: work.attempts + 1, nextAttemptAt })
										.where(eq(gitHubUninstall.id, work.id)),
								);
								return;
							}
							yield* logUninstallError(result.failure);
						}
						yield* query((db) => db.delete(gitHubUninstall).where(eq(gitHubUninstall.id, work.id)));
					}),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

const UNINSTALL_RETRIES = 10;
const UNINSTALL_TIMEOUT = Duration.seconds(30);

const isDue = (now: Date, id?: string) =>
	and(
		lte(gitHubUninstall.nextAttemptAt, now),
		id === undefined ? undefined : eq(gitHubUninstall.id, id),
	);

export const dueIds = (now: Date) =>
	query((db) =>
		db
			.select({ id: gitHubUninstall.id })
			.from(gitHubUninstall)
			.where(isDue(now))
			.orderBy(asc(gitHubUninstall.nextAttemptAt), asc(gitHubUninstall.id)),
	);

export const dueUninstall = (now: Date, id: string) =>
	query((db) =>
		db
			.select({ workspace: gitHubUninstall.workspaceId })
			.from(gitHubUninstall)
			.where(isDue(now, id)),
	);
