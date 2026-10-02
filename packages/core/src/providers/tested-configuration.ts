import type { ProviderStatus } from "@sugabots/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import type { UserFacing } from "../user-message.ts";
import type { Egress, EgressRefused } from "./network/egress.ts";

/**
 * What model providers, search providers and connections share: each is
 * configured with an address and perhaps a key, tried by a test, and shown by
 * how that test went. A test's result belongs to the configuration it tried,
 * so it is recorded only while the row still holds that configuration.
 */

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

/** Fails with {@link UrlNotAllowed} unless the egress policy lets a provider or connection use `url`. */
export const requireAllowedUrl = (egress: Egress.Interface, url: string) =>
	Effect.mapError(egress.validateProviderUrl(url), (refusal) => new UrlNotAllowed({ refusal }));

/** The egress policy refuses the address a provider or connection was given. */
export class UrlNotAllowed
	extends Data.TaggedError("UrlNotAllowed")<{ readonly refusal: EgressRefused }>
	implements UserFacing
{
	override get message() {
		return `The address is not allowed: ${this.refusal.message}`;
	}
	get userMessage() {
		return this.refusal.userMessage;
	}
}
