import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { modelTrialSchema, newModelTrialSchema } from "../../model-trials.ts";
import { uuidSchema } from "../../uuid.ts";
import { Access, Authorise, Session } from "../middleware.ts";

/**
 * Trying a model on a system agent before the workspace relies on it.
 *
 * Admin only, like choosing a provider: it spends model calls, and it decides
 * what the workspace's unattended agents will run on.
 */
export class ModelTrialsApi extends HttpApiGroup.make("modelTrials")
	.add(
		HttpApiEndpoint.post("run", "/workspaces/:workspaceId/model-trials", {
			params: { workspaceId: uuidSchema },
			payload: newModelTrialSchema,
			success: modelTrialSchema,
		}).annotate(Access, { workspace: "workspace.providers.manage" }),
	)
	.middleware(Authorise)
	.middleware(Session) {}
