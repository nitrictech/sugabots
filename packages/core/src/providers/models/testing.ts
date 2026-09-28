import { Effect } from "effect";
import { Models } from "./models.ts";

/** A model client that streams `text` from every request, with no tool calls waiting. */
export const scriptedModel = (...text: string[]): Models.Interface =>
	Models.fromStream(() => Effect.succeed(streamed(chunks(...text))));

/** A model client whose every request fails, for a test that must not reach a model. */
export const unusedModel = (): Models.Interface =>
	Models.fromStream(() =>
		Effect.fail(new Models.RequestFailed({ message: "unused model", reason: "unavailable" })),
	);

/** A finished response with this text, costing `accounting`, and no tool calls waiting. */
export const streamed = (
	text: AsyncIterable<string>,
	accounting: Models.Accounting = { modelCalls: 1 },
): Models.Streamed => ({
	text,
	accounting: Effect.succeed(accounting),
	continuation: Effect.succeed({ approvalRequests: [], responseMessages: [] }),
});

export async function* chunks(...text: string[]): AsyncGenerator<string> {
	yield* text;
}
