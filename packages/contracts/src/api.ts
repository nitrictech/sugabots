import { Schema } from "effect";
import { emailSchema } from "./email.ts";
import { uuidSchema } from "./uuid.ts";
import { workspaceRoleSchema } from "./workspaces.ts";

export const healthResponseSchema = Schema.Struct({
	status: Schema.Literal("ok"),
	version: Schema.String,
});

export type HealthResponse = typeof healthResponseSchema.Type;

export const sessionUserSchema = Schema.Struct({
	id: uuidSchema,
	email: emailSchema,
	name: Schema.String,
	image: Schema.NullOr(Schema.String),
});

export type SessionUser = typeof sessionUserSchema.Type;

export const USER_NAME_MAX_LENGTH = 100;

export const userNameSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(USER_NAME_MAX_LENGTH),
);

export const workspaceMembershipSchema = Schema.Struct({
	role: workspaceRoleSchema,
});

export type WorkspaceMembership = typeof workspaceMembershipSchema.Type;
