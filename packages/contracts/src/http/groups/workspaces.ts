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
import { BadRequest, Conflict, Forbidden, NotFound } from "../errors.ts";
import { Session } from "../middleware.ts";

const workspace = { workspace: workspaceIdOrSlugSchema };

/** Not behind `Authorise`: `Membership` checks each action itself. */
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
			error: [BadRequest, Conflict, Forbidden, NotFound],
		}),
		HttpApiEndpoint.get("members", "/workspaces/:workspace/members", {
			params: workspace,
			success: Schema.Array(workspaceMemberSchema),
			error: [Forbidden, NotFound],
		}),
		HttpApiEndpoint.patch("updateMember", "/workspaces/:workspace/members/:memberId", {
			params: { ...workspace, memberId: uuidSchema },
			payload: workspaceMemberUpdateSchema,
			error: [BadRequest, Forbidden, NotFound],
		}),
		HttpApiEndpoint.delete("removeMember", "/workspaces/:workspace/members/:memberId", {
			params: { ...workspace, memberId: uuidSchema },
			error: [BadRequest, Forbidden, NotFound],
		}),
		HttpApiEndpoint.post("leave", "/workspaces/:workspace/leave", {
			params: workspace,
			error: [BadRequest, Forbidden, NotFound],
		}),
		HttpApiEndpoint.get("invitations", "/workspaces/:workspace/invitations", {
			params: workspace,
			success: Schema.Array(workspaceInvitationSchema),
			error: [Forbidden, NotFound],
		}),
		HttpApiEndpoint.post("invite", "/workspaces/:workspace/invitations", {
			params: workspace,
			payload: newWorkspaceInvitationSchema,
			success: workspaceInvitationSchema.pipe(HttpApiSchema.status(201)),
			error: [Conflict, Forbidden, NotFound],
		}),
		HttpApiEndpoint.delete("cancelInvitation", "/invitations/:invitationId", {
			params: { invitationId: uuidSchema },
			error: [Forbidden, NotFound],
		}),
		HttpApiEndpoint.get("invitation", "/invitations/:invitationId", {
			params: { invitationId: uuidSchema },
			success: invitationPreviewSchema,
			error: [Forbidden, NotFound],
		}),
		HttpApiEndpoint.post("acceptInvitation", "/invitations/:invitationId/accept", {
			params: { invitationId: uuidSchema },
			success: acceptedInvitationSchema,
			error: [Forbidden, NotFound],
		}),
	)
	.middleware(Session) {}
