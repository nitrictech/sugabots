import { Schema } from "effect";
import isISO8601 from "validator/lib/isISO8601.js";
import isRFC3339 from "validator/lib/isRFC3339.js";

export const isoTimestampSchema = Schema.String.check(
	Schema.makeFilter(
		(timestamp) =>
			isISO8601(timestamp, { strict: true, strictSeparator: true }) && isRFC3339(timestamp),
		{
			expected: "an ISO timestamp with a time zone",
			toJsonSchema: () => ({ format: "date-time" }),
		},
	),
);
