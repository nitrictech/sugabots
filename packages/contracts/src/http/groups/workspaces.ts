import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedInvitationSchema,
	invitationPreviewSchema,
	membershipDepartureSchema,
	membershipSchema,
	newWorkspaceInvitationSchema,
	newWorkspaceSchema,
	ownershipHandOverSchema,
	roleChangeSchema,
	workspaceDetailsSchema,
	workspaceInvitationSchema,
	workspaceSchema,
	workspaceTimeZoneChangeSchema,
	workspaceTimeZoneSchema,
} from "../../membership.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const workspace = { workspace: workspaceIdOrSlugSchema };

export class WorkspacesApi extends HttpApiGroup.make("workspaces")
	.add(
		HttpApiEndpoint.get("list", "/workspaces", {
			success: Schema.Array(workspaceSchema),
		}),
		HttpApiEndpoint.post("create", "/workspaces", {
			payload: newWorkspaceSchema,
			success: workspaceSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.patch("update", "/workspaces/:workspace", {
			params: workspace,
			payload: workspaceDetailsSchema,
			success: workspaceSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("timeZone", "/workspaces/:workspace/time-zone", {
			params: workspace,
			success: workspaceTimeZoneSchema,
			error: refused,
		}),
		HttpApiEndpoint.put("changeTimeZone", "/workspaces/:workspace/time-zone", {
			params: workspace,
			payload: workspaceTimeZoneChangeSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("delete", "/workspaces/:workspace", {
			params: workspace,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.get("memberships", "/workspaces/:workspace/memberships", {
			params: workspace,
			success: Schema.Array(membershipSchema),
			error: refused,
		}),
		HttpApiEndpoint.patch("changeRole", "/workspaces/:workspace/memberships/:membershipId", {
			params: { ...workspace, membershipId: uuidSchema },
			payload: roleChangeSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeMembership", "/workspaces/:workspace/memberships/:membershipId", {
			params: { ...workspace, membershipId: uuidSchema },
			success: membershipDepartureSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.put("handOverOwnership", "/workspaces/:workspace/owner", {
			params: workspace,
			payload: ownershipHandOverSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("leave", "/workspaces/:workspace/leave", {
			params: workspace,
			success: membershipDepartureSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("invitations", "/workspaces/:workspace/invitations", {
			params: workspace,
			success: Schema.Array(workspaceInvitationSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("invite", "/workspaces/:workspace/invitations", {
			params: workspace,
			payload: newWorkspaceInvitationSchema,
			success: workspaceInvitationSchema.pipe(HttpApiSchema.status(201)),
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("cancelInvitation", "/invitations/:invitationId", {
			params: { invitationId: uuidSchema },
			error: refused,
		}),
		HttpApiEndpoint.get("invitation", "/invitations/:invitationId", {
			params: { invitationId: uuidSchema },
			success: invitationPreviewSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("acceptInvitation", "/invitations/:invitationId/accept", {
			params: { invitationId: uuidSchema },
			success: acceptedInvitationSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
