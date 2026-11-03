import { Schema } from "effect";

/** Longer than any IANA name, short enough that nothing slow runs on a long one. */
export const MAX_TIMEZONE_CHARACTERS = 100;

/**
 * An IANA time zone, such as `Australia/Sydney`. Named zones only: an offset
 * such as `+05:00` means the opposite direction to Postgres, which reads it
 * the POSIX way.
 */
export const timeZoneSchema = Schema.String.check(
	Schema.isMaxLength(MAX_TIMEZONE_CHARACTERS),
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
