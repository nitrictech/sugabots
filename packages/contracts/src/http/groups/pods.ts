import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { modelIdSchema } from "../../agents.ts";
import {
	newPodMemberSchema,
	newPodSchema,
	podMemberSchema,
	podSchema,
	podUpdateSchema,
} from "../../pods.ts";
import { uuidSchema } from "../../uuid.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/**
 * Pods, and who is in them.
 *
 * Domain law — a Personal pod cannot be renamed, deleted or given other
 * members — is enforced by core, whatever entry point reaches it. These say
 * what each refusal means over HTTP.
 */
export class PodsApi extends HttpApiGroup.make("pods")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/pods", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(podSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/pods", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newPodSchema,
			success: podSchema.pipe(HttpApiSchema.status(201)),
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.post("ensurePersonal", "/workspaces/:workspace/personal-pod", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: Schema.Struct({ model: modelIdSchema }),
			success: podSchema.pipe(HttpApiSchema.status(201)),
			error: refused,
		}),
		HttpApiEndpoint.patch("update", "/pods/:podId", {
			params: { podId: uuidSchema },
			payload: podUpdateSchema,
			success: podSchema,
			error: [Conflict, ...refused],
		}),
		HttpApiEndpoint.delete("remove", "/pods/:podId", {
			params: { podId: uuidSchema },
			error: refused,
		}),
		HttpApiEndpoint.get("listMembers", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			success: Schema.Array(podMemberSchema),
			error: refused,
		}),
		HttpApiEndpoint.post("addMember", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			payload: newPodMemberSchema,
			error: refused,
		}),
		HttpApiEndpoint.delete("removeMember", "/pods/:podId/members/:userId", {
			params: { podId: uuidSchema, userId: Schema.String },
			error: refused,
		}),
		/** Takes the caller out of the pod. */
		HttpApiEndpoint.delete("leave", "/pods/:podId/membership", {
			params: { podId: uuidSchema },
			error: refused,
		}),
	)
	.middleware(Session) {}
