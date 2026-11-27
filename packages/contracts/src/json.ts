import { Schema } from "effect";

/** Any JSON value, checked all the way down but typed `unknown`. */
export const anyJsonSchema = Schema.Unknown.check(
	Schema.makeFilter(Schema.is(Schema.Json), { expected: "a JSON value" }),
);
