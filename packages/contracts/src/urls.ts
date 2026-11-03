import { Result, Schema } from "effect";

/** As long as a URL may be: the most browsers and servers reliably take. */
export const MAX_URL_CHARACTERS = 2_048;

/** An http or https address. */
export const httpUrlSchema = Schema.Trim.check(
	Schema.isMaxLength(MAX_URL_CHARACTERS),
	Schema.makeFilter((value) => Result.isSuccess(Schema.decodeResult(Schema.URLFromString)(value)), {
		message: "Invalid URL",
	}),
	Schema.makeFilter((value) => /^https?:\/\//i.test(value), { message: "Use an HTTP URL" }),
);
