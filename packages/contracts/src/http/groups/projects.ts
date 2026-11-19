import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { botSchema } from "../../bots.ts";
import {
	newProjectMemberSchema,
	newProjectSchema,
	projectMemberSchema,
	projectSchema,
	projectUpdateSchema,
} from "../../projects.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * Projects, who is in them, and their bots. `list` answers the projects the
 * caller is in and the public ones they could join, as the directory shows.
 */
export class ProjectsApi extends HttpApiGroup.make("projects")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/projects", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(projectSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/projects", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newProjectSchema,
			success: projectSchema.pipe(HttpApiSchema.status(201)),
			error: [BadRequest, Conflict, ...refused],
		}),
		HttpApiEndpoint.patch("update", "/projects/:projectId", {
			params: { projectId: uuidSchema },
			payload: projectUpdateSchema,
			success: projectSchema,
			error: [BadRequest, Conflict, ...refused],
		}),
		/** Refused with a conflict while its computer's provider can't be reached to destroy it. */
		HttpApiEndpoint.delete("remove", "/projects/:projectId", {
			params: { projectId: uuidSchema },
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.get("listMembers", "/projects/:projectId/members", {
			params: { projectId: uuidSchema },
			success: Schema.Array(projectMemberSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addMember", "/projects/:projectId/members", {
			params: { projectId: uuidSchema },
			payload: newProjectMemberSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("removeMember", "/projects/:projectId/members/:userId", {
			params: { projectId: uuidSchema, userId: Schema.String },
			error: refused,
		}),
		/** Takes the caller out of the project. */
		HttpApiEndpoint.delete("leave", "/projects/:projectId/membership", {
			params: { projectId: uuidSchema },
			error: refused,
		}),
		/** Puts the caller in a public project. */
		HttpApiEndpoint.put("join", "/projects/:projectId/membership", {
			params: { projectId: uuidSchema },
			success: projectSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("listBots", "/projects/:projectId/bots", {
			params: { projectId: uuidSchema },
			success: Schema.Array(botSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addBot", "/projects/:projectId/bots", {
			params: { projectId: uuidSchema },
			payload: Schema.Struct({ botId: uuidSchema }),
			error: [BadRequest, ...refused],
		}),
		/** Refused for the project's lead bot, until another is chosen. */
		HttpApiEndpoint.delete("removeBot", "/projects/:projectId/bots/:botId", {
			params: { projectId: uuidSchema, botId: uuidSchema },
			error: [Conflict, ...refused],
		}),
	)
	.middleware(Session) {}
