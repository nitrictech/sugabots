import type { ProviderStatus } from "@sugabots/contracts";
import { UrlNotAllowed } from "@sugabots/contracts/errors/providers";
import type { UserText } from "@sugabots/errors";
import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Clock, Effect } from "effect";
import { type Egress, workspaceUrlRefusal } from "./network/egress.ts";

/**
 * What model providers, search providers and connectors share: each is
 * configured with an address and perhaps a key, tried by a test, and shown by
 * how that test went. A test's result belongs to the configuration it tried,
 * so it is recorded only while the row still holds that configuration.
 */

/**
 * Whether an update's address, `next` (absent when the update leaves the
 * address alone), differs from `stored`. A row whose address changes loses
 * every secret the update does not give it anew: a secret goes only where it
 * was given for, and one kept would be sent to the new address, which whoever
 * changed it may own.
 */
export function changesAddress(next: string | undefined, stored: string): boolean {
	return next !== undefined && next !== stored;
}

/**
 * SQL that is true while a row still has the configuration `testedAt` was read
 * from, `testedAt` being the row's `updatedAt` as the test loaded it. Postgres
 * stamps `updatedAt` to the microsecond and a `Date` holds only milliseconds,
 * so the two are compared at that precision.
 */
export function stillConfiguredAs(updatedAt: PgColumn, testedAt: Date): SQL {
	return sql`date_trunc('milliseconds', ${updatedAt}) = ${testedAt}`;
}

/** How a configuration stands: a required key missing, never tried, or how its last test went. */
export function configurationStatus(row: {
	missingKey: boolean;
	lastTestedAt: Date | null;
	lastTestError: string | null;
}): ProviderStatus {
	if (row.missingKey) return "missing_key";
	if (row.lastTestedAt === null) return "untested";
	return row.lastTestError === null ? "connected" : "error";
}

/**
 * Fails with {@link UrlNotAllowed} unless the egress policy lets a model
 * provider, search provider, computer provider or connector use `url`.
 */
export const requireAllowedUrl = (egress: Egress.Interface, url: string) =>
	Effect.mapError(
		egress.validateProviderUrl(url),
		(refusal) => new UrlNotAllowed({ refusal: workspaceUrlRefusal(refusal) }),
	);

/** How a test went, with what else it found: `error` is why it failed, if it did. */
type Tested<Found extends { error?: UserText }> = Omit<Found, "error"> & {
	reachable: boolean;
	latencyMs: number;
	error?: UserText;
};

/** Runs `test`, which answers with why it failed, if it did, timing how long it took. */
export const timedTest = <Found extends { error?: UserText }, E, R>(
	test: Effect.Effect<Found, E, R>,
): Effect.Effect<Tested<Found>, E, R> =>
	Effect.gen(function* () {
		const started = yield* Clock.currentTimeMillis;
		const found = yield* test;
		const latencyMs = (yield* Clock.currentTimeMillis) - started;
		return { ...found, reachable: found.error === undefined, latencyMs };
	});
