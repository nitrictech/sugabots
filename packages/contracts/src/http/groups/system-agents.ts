import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { systemAgentSchema, systemAgentUpdateSchema } from "../../system-agents.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Authorise, Session } from "../middleware.ts";

/**
 * The workspace's Scribe and Facilitator: what they are, and the model each
 * runs on.
 *
 * Addressed by key rather than by id, because there is exactly one of each per
 * workspace. That is also what keeps this from being pointed at a crew agent,
 * which is configured in its pod instead.
 *
 * Reading is open to the whole workspace, because a pod's routing options
 * depend on the answer: the owner of a Personal pod holds every permission in
 * it whatever their workspace role, and their settings screen has to tell "no
 * model chosen" apart from "you cannot see". What is exposed is two names and
 * two model ids, which a member already sees on every crew agent in their pods.
 */
export class SystemAgentsApi extends HttpApiGroup.make("systemAgents")
	.add(
		HttpApiEndpoint.get("list", "/workspaces/:workspace/system-agents", {
			params: { workspace: workspaceIdOrSlugSchema },
			success: Schema.Array(systemAgentSchema),
		}),
		// The key is a string here rather than `systemAgentKeySchema`, so a key
		// that names no system agent is `NotFound` like any other missing thing,
		// not a malformed request.
		HttpApiEndpoint.patch("update", "/workspaces/:workspace/system-agents/:key", {
			params: { workspace: workspaceIdOrSlugSchema, key: Schema.String },
			payload: systemAgentUpdateSchema,
			success: systemAgentSchema,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
