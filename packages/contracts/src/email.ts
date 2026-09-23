import { Schema } from "effect";
import isEmail from "validator/lib/isEmail.js";

export const emailSchema = Schema.String.check(
	Schema.makeFilter((email) => isEmail(email), {
		expected: "an email address",
		toJsonSchema: () => ({ format: "email" }),
	}),
);
