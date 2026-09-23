import {
	type SystemAgentKey,
	systemAgentKeySchema,
	systemAgentUpdateSchema,
} from "@sugabots/contracts";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { AgentModelNotEnabled } from "@sugabots/core/workspaces/agents/operations";
import type {
	SystemAgentMissing,
	SystemAgentStore,
} from "@sugabots/core/workspaces/agents/system-agent-store";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

/**
 * The workspace's Scribe and Facilitator: what they are, and the model each
 * runs on.
 *
 * Addressed by key rather than by id, because there is exactly one of each per
 * workspace. That is also what keeps this route from being pointed at a crew
 * agent, which is configured in its pod instead.
 *
 * Only an administrator may choose the model, and the settings screen for doing
 * so is theirs alone. Reading is open to the whole workspace even so, because a
 * pod's routing options depend on the answer: the owner of a Personal pod holds
 * every permission in it whatever their workspace role, so anybody may reach
 * that screen, and it has to tell "no model chosen" apart from "you cannot see".
 * Without that, a member could not switch on routing their workspace supports.
 * What is exposed is two names and two model ids, which a member already sees on
 * every crew agent in their pods.
 */
export interface SystemAgentRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	systemAgents: SystemAgentStore;
	modelProviders: Pick<ModelProviderStore, "isEnabled">;
}

export function createSystemAgentRoutes({
	resolveSession,
	authorization,
	run,
	systemAgents,
	modelProviders,
}: SystemAgentRoutesOptions) {
	const session = requireSession(resolveSession);
	const inWorkspace = requireWorkspace(authorization, run, "workspace.read");
	const configures = requireWorkspace(authorization, run, "workspace.builtInAgents.configure");

	return new Hono<AuthEnv>()
		.get("/workspaces/:workspaceId/system-agents", session, inWorkspace, async (c) =>
			c.json(await run(systemAgents.list(c.get("workspace").workspaceId))),
		)
		.patch(
			"/workspaces/:workspaceId/system-agents/:key",
			session,
			configures,
			body(systemAgentUpdateSchema),
			async (c) => {
				const key = systemAgentKeyOf(c.req.param("key"));
				const { workspaceId } = c.get("workspace");
				const { model } = c.req.valid("json");
				// Turning one off names no model, so there is nothing to check that
				// the workspace can reach. Choosing one is checked as a crew agent's
				// is: a model the workspace has not enabled is a bad request.
				const usableModel =
					model === null
						? Effect.void
						: Effect.filterOrFail(
								modelProviders.isEnabled(workspaceId, model),
								(enabled) => enabled,
								() => new AgentModelNotEnabled({ model }),
							).pipe(Effect.asVoid);
				return c.json(
					await run(
						usableModel
							.pipe(Effect.andThen(() => systemAgents.setModel(workspaceId, key, model)))
							.pipe(asHttpError(systemAgentErrors)),
					),
				);
			},
		);
}

/** The key in the path, or a bad request — the path names one of two agents. */
function systemAgentKeyOf(value: string | undefined): SystemAgentKey {
	const decoded = Schema.decodeUnknownOption(systemAgentKeySchema)(value);
	if (decoded._tag === "None") {
		throw new HttpError("not_found", "No such built-in agent");
	}
	return decoded.value;
}

const systemAgentErrors = {
	AgentModelNotEnabled: (failure: AgentModelNotEnabled) =>
		new HttpError("bad_request", failure.message),
	SystemAgentMissing: (failure: SystemAgentMissing) => new HttpError("not_found", failure.message),
};
