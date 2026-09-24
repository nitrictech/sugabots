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
		HttpApiEndpoint.get("list", "/workspaces/:workspaceId/pods", {
			params: { workspaceId: uuidSchema },
			success: Schema.Array(podSchema),
		}),
		HttpApiEndpoint.post("create", "/workspaces/:workspaceId/pods", {
			params: { workspaceId: uuidSchema },
			payload: newPodSchema,
			success: podSchema.pipe(HttpApiSchema.status(201)),
			error: Conflict,
		}),
		HttpApiEndpoint.post("ensurePersonal", "/workspaces/:workspaceId/personal-pod", {
			params: { workspaceId: uuidSchema },
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
		// Reached without pod membership: this is how the first person is added
		// to a pod the admin is not in themselves.
		HttpApiEndpoint.post("addMember", "/pods/:podId/members", {
			params: { podId: uuidSchema },
			payload: newPodMemberSchema,
		}),
		HttpApiEndpoint.delete("removeMember", "/pods/:podId/members/:userId", {
			params: { podId: uuidSchema, userId: Schema.String },
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
