import { Schema } from "effect";
import { emailSchema } from "./email.ts";
import { uuidSchema } from "./uuid.ts";
import { workspaceRoleSchema } from "./workspaces.ts";

export const apiErrorCodeSchema = Schema.Literals([
	"bad_request",
	"unauthorized",
	"forbidden",
	"not_found",
	"conflict",
	"internal",
]);

export type ApiErrorCode = typeof apiErrorCodeSchema.Type;

const apiErrorCodeByStatus: Readonly<Record<number, ApiErrorCode>> = {
	400: "bad_request",
	401: "unauthorized",
	403: "forbidden",
	404: "not_found",
	409: "conflict",
	500: "internal",
};

export function apiErrorCodeForStatus(status: number): ApiErrorCode {
	return apiErrorCodeByStatus[status] ?? (status >= 500 ? "internal" : "bad_request");
}

export const errorResponseSchema = Schema.Struct({
	error: Schema.Struct({
		code: apiErrorCodeSchema,
		message: Schema.String,
		details: Schema.optional(Schema.Unknown),
	}),
});

export type ErrorResponse = typeof errorResponseSchema.Type;

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

export const workspaceMembershipSchema = Schema.Struct({
	role: workspaceRoleSchema,
});

export type WorkspaceMembership = typeof workspaceMembershipSchema.Type;
