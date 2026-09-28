import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { providerModel } from "../../database/schema.ts";
import { contextWindowTokens } from "./window.ts";

/**
 * The window a workspace's model is treated as having: the context length its
 * provider reports, capped at `MAX_CONTEXT_WINDOW_TOKENS`, or that cap when the
 * model is not listed or its length is unknown.
 */
export const loadContextWindow = Effect.fn("ContextWindow.loadContextWindow")(function* (
	db: Executor,
	workspaceId: string,
	modelId: string,
) {
	const [row] = yield* db
		.select({ contextLength: providerModel.contextLength })
		.from(providerModel)
		.where(and(eq(providerModel.workspaceId, workspaceId), eq(providerModel.modelId, modelId)))
		.limit(1);
	return contextWindowTokens(row?.contextLength);
});
