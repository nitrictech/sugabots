import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { modelTrialSchema, newModelTrialSchema } from "../../model-trials.ts";
import { workspaceIdOrSlugSchema } from "../../workspaces.ts";
import { Authorise, Session } from "../middleware.ts";

/**
 * Trying a model on a system agent before the workspace relies on it.
 *
 * Admin only, like choosing a provider: it spends model calls, and it decides
 * what the workspace's unattended agents will run on.
 */
export class ModelTrialsApi extends HttpApiGroup.make("modelTrials")
	.add(
		HttpApiEndpoint.post("run", "/workspaces/:workspace/model-trials", {
			params: { workspace: workspaceIdOrSlugSchema },
			payload: newModelTrialSchema,
			success: modelTrialSchema,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
