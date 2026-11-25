import { Schema } from "effect";
import { currentUserSchema } from "./api.ts";
import { emailSchema } from "./email.ts";
import { slugSchema } from "./projects.ts";
import { timeZoneSchema } from "./time-zones.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";
import { assignableWorkspaceRoleSchema, workspaceRoleSchema } from "./workspaces.ts";

/** Unique across the server. */
const workspaceSlugSchema = slugSchema;

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
	setUpAt: Schema.NullOr(isoTimestampSchema),
});
export type Workspace = typeof workspaceSchema.Type;

export const WORKSPACE_NAME_MAX_LENGTH = 64;

export const workspaceDetailsSchema = Schema.Struct({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(WORKSPACE_NAME_MAX_LENGTH)),
	slug: workspaceSlugSchema,
});
export type WorkspaceDetails = typeof workspaceDetailsSchema.Type;

export const newWorkspaceSchema = Schema.Struct({
	...workspaceDetailsSchema.fields,
	/** The creator's own time zone. Without one, the workspace is in `DEFAULT_TIME_ZONE`. */
	timeZone: Schema.optional(timeZoneSchema),
});
export type NewWorkspace = typeof newWorkspaceSchema.Type;

/**
 * The workspace's time zone, and how many of its automations have a routine in
 * that zone. Those routines move with the workspace when its zone changes.
 */
export const workspaceTimeZoneSchema = Schema.Struct({
	timeZone: Schema.String,
	automationsWithRoutines: Schema.Number,
});
export type WorkspaceTimeZone = typeof workspaceTimeZoneSchema.Type;

export const workspaceTimeZoneChangeSchema = Schema.Struct({ timeZone: timeZoneSchema });

/** `id` is the membership, which role changes and removal address. */
export const membershipSchema = Schema.Struct({
	id: uuidSchema,
	role: workspaceRoleSchema,
	member: currentUserSchema,
	joinedAt: isoTimestampSchema,
});
export type Membership = typeof membershipSchema.Type;

export const membershipDepartureSchema = Schema.Struct({ cleanupPending: Schema.Boolean });
export type MembershipDeparture = typeof membershipDepartureSchema.Type;

export const roleChangeSchema = Schema.Struct({ role: assignableWorkspaceRoleSchema });

/** Who the owner hands the workspace over to: a member in it, by their membership's id. */
export const ownershipHandOverSchema = Schema.Struct({ membershipId: uuidSchema });

/** How many days an invitation can be accepted for after it is sent or sent again. */
export const INVITATION_LIFETIME_DAYS = 2;

/** An invitation still waiting to be accepted. */
export const workspaceInvitationSchema = Schema.Struct({
	id: uuidSchema,
	email: emailSchema,
	role: assignableWorkspaceRoleSchema,
	expiresAt: isoTimestampSchema,
	/** When the invitation was last emailed: when it was created, or last sent again. */
	sentAt: isoTimestampSchema,
});
export type WorkspaceInvitation = typeof workspaceInvitationSchema.Type;

export const newWorkspaceInvitationSchema = Schema.Struct({
	email: emailSchema,
	role: assignableWorkspaceRoleSchema,
	/** Refreshes an invitation already pending for this address, and sends it again. */
	resend: Schema.optional(Schema.Boolean),
});
export type NewWorkspaceInvitation = typeof newWorkspaceInvitationSchema.Type;

/**
 * An invitation as the member it was sent to sees it: one still to accept, or
 * one they have accepted already, whose link leads back into its workspace.
 */
export const invitationPreviewSchema = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("pending"),
		workspaceName: Schema.String,
		inviterName: Schema.String,
		/** The role the member will have in the workspace once they accept. */
		role: workspaceRoleSchema,
	}),
	Schema.Struct({ status: Schema.Literal("accepted"), workspaceId: uuidSchema }),
]);
export type InvitationPreview = typeof invitationPreviewSchema.Type;

export const acceptedInvitationSchema = Schema.Struct({ workspaceId: uuidSchema });
