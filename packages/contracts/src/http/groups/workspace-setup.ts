import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { completeWorkspaceSetupSchema } from "../../workspace-setup.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/** The current user finishing setting up a workspace. */
export class WorkspaceSetupApi extends HttpApiGroup.make("workspaceSetup")
	.add(
		HttpApiEndpoint.post("complete", "/workspace-setup/complete", {
			payload: completeWorkspaceSetupSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
