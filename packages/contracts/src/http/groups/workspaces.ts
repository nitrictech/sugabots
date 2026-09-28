import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	acceptedInvitationSchema,
	invitationPreviewSchema,
	newWorkspaceInvitationSchema,
	workspaceDetailsSchema,
	workspaceInvitationSchema,
	workspaceMemberSchema,
	workspaceMemberUpdateSchema,
	workspaceSchema,
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
			payload: workspaceDetailsSchema,
			success: workspaceSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict],
		}),
		HttpApiEndpoint.patch("update", "/workspaces/:workspace", {
			params: workspace,
			payload: workspaceDetailsSchema,
			success: workspaceSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.get("members", "/workspaces/:workspace/members", {
			params: workspace,
			success: Schema.Array(workspaceMemberSchema),
			error: refused,
		}),
		HttpApiEndpoint.patch("updateMember", "/workspaces/:workspace/members/:memberId", {
			params: { ...workspace, memberId: uuidSchema },
			payload: workspaceMemberUpdateSchema,
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.delete("removeMember", "/workspaces/:workspace/members/:memberId", {
			params: { ...workspace, memberId: uuidSchema },
			error: [BadRequest, ...refused],
		}),
		HttpApiEndpoint.post("leave", "/workspaces/:workspace/leave", {
			params: workspace,
			error: [BadRequest, ...refused],
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
