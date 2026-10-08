import { DisplayName } from "@sugabots/errors";
import { Effect } from "effect";
import type { ModelProviderRepository } from "../model-providers/model-provider-repository.ts";
import { Models } from "./models.ts";

/** `endpoint` as the provider offering the model, under test names. */
export const resolvedModel = (
	endpoint: ModelProviderRepository.ProviderEndpoint,
): ModelProviderRepository.ResolvedModel => ({
	endpoint,
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

/** A response with this text that ended as `finished` says: by default after one model call, with no tool calls waiting. */
export const streamed = (
	text: AsyncIterable<string>,
	finished: Partial<Models.Finished> = {},
): Models.Streamed => ({
	text,
	finished: Effect.succeed({
		modelCalls: 1,
		approvalRequests: [],
		responseMessages: [],
		...finished,
	}),
});

export async function* chunks(...text: string[]): AsyncGenerator<string> {
	yield* text;
}
