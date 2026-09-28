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
import { Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

/**
 * Pods, and who is in them.
 *
 * Domain law — a Personal pod cannot be renamed, deleted or given other
 * members — is the store's, which is the only thing that can enforce it
 * whatever reaches it. These say what each refusal means over HTTP.
 */
export class PodsApi extends HttpApiGroup.make("pods")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/pods", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(podSchema),
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspace/pods", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newPodSchema,
			success: podSchema.pipe(HttpApiSchema.status(201)),
			error: Conflict,
		}),
		HttpApiEndpoint.post("ensurePersonal", "/workspaces/:workspace/personal-pod", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: Schema.Struct({ model: modelIdSchema }),
			success: podSchema.pipe(HttpApiSchema.status(201)),
		}),
		HttpApiEndpoint.patch("update", "/pods/:podId", {
			params: { podId: uuidSchema },
			payload: podUpdateSchema,
			success: podSchema,
			error: Conflict,
		}),
		HttpApiEndpoint.delete("remove", "/pods/:podId", {
			params: { podId: uuidSchema },
		}),
		HttpApiEndpoint.get("listMembers", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			success: Schema.Array(podMemberSchema),
		}),
		HttpApiEndpoint.post("addMember", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			payload: newPodMemberSchema,
		}),
		HttpApiEndpoint.delete("removeMember", "/pods/:podId/members/:userId", {
			params: { podId: uuidSchema, userId: Schema.String },
		}),
		/** Takes the caller out of the pod. */
		HttpApiEndpoint.delete("leave", "/pods/:podId/membership", {
			params: { podId: uuidSchema },
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
