import { Schema } from "effect";

/**
 * An IANA time zone, such as `Australia/Sydney`. Named zones only: an offset
 * such as `+05:00` means the opposite direction to Postgres, which reads it
 * the POSIX way.
 */
export const timeZoneSchema = Schema.String.check(
	Schema.isPattern(/^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+)*$/),
	Schema.makeFilter(isTimeZone, { message: "Expected an IANA time zone" }),
);
export type TimeZone = typeof timeZoneSchema.Type;

/** The time zone of a workspace created without one, and of every workspace made before they had one. */
export const DEFAULT_TIME_ZONE = "UTC";

function isTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}
