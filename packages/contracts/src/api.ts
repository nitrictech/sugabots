import { Schema } from "effect";
import { emailSchema } from "./email.ts";
import { uuidSchema } from "./uuid.ts";

export const healthResponseSchema = Schema.Struct({
	status: Schema.Literal("ok"),
	/** A release such as `0.2.0`, `edge` for a published build of main, or `unknown`; not always semver. */
	version: Schema.String,
	/** The commit the build was made from, or null when the build didn't record one. */
	commit: Schema.NullOr(Schema.String),
});

export type HealthResponse = typeof healthResponseSchema.Type;

export const signedInPersonSchema = Schema.Struct({
	id: uuidSchema,
	email: emailSchema,
	name: Schema.String,
	image: Schema.NullOr(Schema.String),
});

export type SignedInPerson = typeof signedInPersonSchema.Type;

/** A person named beside something they did, such as connecting a provider, while they are still in the workspace. */
export const namedPersonSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	/** As the workspace's list of people shows it, for a picture of them where they have none of their own. */
	email: emailSchema,
	image: Schema.NullOr(Schema.String),
});

export type NamedPerson = typeof namedPersonSchema.Type;

export const PERSON_NAME_MAX_LENGTH = 100;

export const personNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(PERSON_NAME_MAX_LENGTH),
);
