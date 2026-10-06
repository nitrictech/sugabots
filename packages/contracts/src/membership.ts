import { Schema } from "effect";
import { sessionUserSchema } from "./api.ts";
import { emailSchema } from "./email.ts";
import { podSlugSchema } from "./pods.ts";
import { timeZoneSchema } from "./time-zones.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";
import { assignableWorkspaceRoleSchema, workspaceRoleSchema } from "./workspaces.ts";

/** Unique across the installation. */
export const workspaceSlugSchema = podSlugSchema;

export const workspaceSchema = Schema.Struct({
	id: uuidSchema,
	name: Schema.String,
	slug: Schema.String,
	/**
	 * The IANA time zone where the workspace's days and months begin, such as
	 * for what its models cost. Checked when it is set, not when it is read:
	 * which zones exist depends on the runtime, and one this runtime doesn't
	 * know must not stop the workspace loading.
	 */
	timeZone: Schema.String,
	/** When its setup was finished, or null while it is still being set up. */
	setupCompletedAt: Schema.NullOr(isoTimestampSchema),
});
export type Workspace = typeof workspaceSchema.Type;

export const workspaceDetailsSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1)),
	slug: workspaceSlugSchema,
});
export type WorkspaceDetails = typeof workspaceDetailsSchema.Type;

export const newWorkspaceSchema = Schema.Struct({
	...workspaceDetailsSchema.fields,
	/** The creator's own time zone. Without one, the workspace is in `DEFAULT_TIME_ZONE`. */
	timeZone: Schema.optional(timeZoneSchema),
});
export type NewWorkspace = typeof newWorkspaceSchema.Type;

/** `id` is the membership, which role changes and removal address. */
export const workspaceMemberSchema = Schema.Struct({
	id: uuidSchema,
	role: workspaceRoleSchema,
	user: sessionUserSchema,
	joinedAt: isoTimestampSchema,
});
export type WorkspaceMember = typeof workspaceMemberSchema.Type;

export const workspaceMemberUpdateSchema = Schema.Struct({ role: assignableWorkspaceRoleSchema });

/** Who the owner hands the workspace to: one of its members, by membership id. */
export const ownershipTransferSchema = Schema.Struct({ memberId: uuidSchema });

/** An invitation still waiting to be accepted. */
export const workspaceInvitationSchema = Schema.Struct({
	id: uuidSchema,
	email: emailSchema,
	role: assignableWorkspaceRoleSchema,
	expiresAt: isoTimestampSchema,
});
export type WorkspaceInvitation = typeof workspaceInvitationSchema.Type;

export const newWorkspaceInvitationSchema = Schema.Struct({
	email: emailSchema,
	role: assignableWorkspaceRoleSchema,
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
