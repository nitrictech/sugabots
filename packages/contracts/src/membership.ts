import { Schema } from "effect";
import { sessionUserSchema } from "./api.ts";
import { emailSchema } from "./email.ts";
import { podSlugSchema } from "./pods.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";
import { workspaceRoleSchema } from "./workspaces.ts";

/** Unique across the installation. */
export const workspaceSlugSchema = podSlugSchema;

export const workspaceSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	slug: Schema.String,
});
export type Workspace = typeof workspaceSchema.Type;

export const workspaceDetailsSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1)),
	slug: workspaceSlugSchema,
});
export type WorkspaceDetails = typeof workspaceDetailsSchema.Type;

/** `id` is the membership, which role changes and removal address. */
export const workspaceMemberSchema = Schema.Struct({
	id: uuidSchema,
	role: workspaceRoleSchema,
	user: sessionUserSchema,
	joinedAt: isoTimestampSchema,
});
export type WorkspaceMember = typeof workspaceMemberSchema.Type;

export const workspaceMemberUpdateSchema = Schema.Struct({ role: workspaceRoleSchema });

/** An invitation still waiting to be accepted. */
export const workspaceInvitationSchema = Schema.Struct({
	id: uuidSchema,
	email: emailSchema,
	role: workspaceRoleSchema,
	expiresAt: isoTimestampSchema,
});
export type WorkspaceInvitation = typeof workspaceInvitationSchema.Type;

export const newWorkspaceInvitationSchema = Schema.Struct({
	email: emailSchema,
	role: workspaceRoleSchema,
	/** Refreshes an invitation already outstanding to this address, and sends it again. */
	resend: Schema.optional(Schema.Boolean),
});
export type NewWorkspaceInvitation = typeof newWorkspaceInvitationSchema.Type;

export const invitationPreviewSchema = Schema.Struct({
	workspaceName: Schema.String,
	inviterName: Schema.String,
});
export type InvitationPreview = typeof invitationPreviewSchema.Type;

export const acceptedInvitationSchema = Schema.Struct({ workspaceId: uuidSchema });
