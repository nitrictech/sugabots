import { DisplayName } from "@sugabots/errors";
import { Effect } from "effect";
import type { ModelRegistry } from "../model-providers/dialects/index.ts";
import type { ModelProviderStore } from "../model-providers/model-provider-store.ts";
import { Models } from "./models.ts";

/** A model registry that fills nothing in, for a test about something else. */
export const emptyRegistry: ModelRegistry = {
	complete: (model) => model,
	cost: () => undefined,
	version: "empty",
};

/** `access` as the provider offering the model, under test names. */
export const resolvedModel = (
	access: ModelProviderStore.ProviderAccess,
): ModelProviderStore.ResolvedModel => ({
	access,
	providerName: DisplayName.fromRecord("Test provider"),
	modelName: DisplayName.fromRecord("test-model"),
});

/** A model client that streams `text` from every request, with no tool calls waiting. */
export const scriptedModel = (...text: string[]): Models.Interface =>
	Models.fromStream(() => Effect.succeed(streamed(chunks(...text))));

/** A model client whose every request fails, for a test that must not reach a model. */
export const unusedModel = (): Models.Interface =>
	Models.fromStream(() =>
		Effect.fail(new Models.ModelNotOffered({ model: DisplayName.fromRecord("unused model") })),
	);

/** A response with this text that ended as `finished` says: by default after one model request, with no tool calls waiting. */
export const streamed = (
	text: AsyncIterable<string>,
	finished: Partial<Models.Finished> = {},
): Models.Streamed => ({
	text,
	finished: Effect.succeed({
		modelRequests: 1,
		approvalRequests: [],
		responseMessages: [],
		...finished,
	}),
});

export async function* chunks(...text: string[]): AsyncGenerator<string> {
	yield* text;
}
