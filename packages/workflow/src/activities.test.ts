import { Context, Effect, Schema } from "effect";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { Activities } from "./activities.ts";

interface Chat {
	readonly chat: string;
}

class Steps extends Context.Service<
	Steps,
	{
		readonly start: (payload: Chat) => Effect.Effect<void>;
		readonly reply: (
			payload: Chat,
			input: { readonly to: string; readonly round: number },
		) => Effect.Effect<string>;
	}
>()("test/Steps") {}

const activities = Activities.fromService<Chat>()(Steps, {
	start: {},
	reply: {
		input: Schema.Struct({ to: Schema.String, round: Schema.Finite }),
		success: Schema.String,
	},
});

const Replying = Workflow.make("test/replying", {
	payload: { chat: Schema.String },
	idempotencyKey: (payload) => payload.chat,
});

const steps = Steps.of({
	start: () => Effect.void,
	reply: ({ chat }, { to, round }) => Effect.succeed(`${chat}:${to}:${round}`),
});

describe("activity definitions", () => {
	it("names an activity by its method and input", () => {
		expect(activities.activity("start", { chat: "t" }).name).toBe("start");
		expect(activities.activity("reply", { chat: "t" }, { to: "sam", round: 3 }).name).toBe(
			'reply/{"to":"sam","round":3}',
		);
	});

	it("rebuilds an activity from its full name and the payload, with its input", async () => {
		const rebuilt = activities.resolve('reply/{"to":"sam","round":3}', { chat: "t" });

		expect(rebuilt?.name).toBe('reply/{"to":"sam","round":3}');
		expect(
			await Effect.runPromise(
				(rebuilt?.execute ?? Effect.die("unresolved")).pipe(
					Effect.provideService(Steps, steps),
					Effect.provideService(
						WorkflowEngine.WorkflowInstance,
						WorkflowEngine.WorkflowInstance.initial(Replying, "execution"),
					),
					Effect.scoped,
				) as Effect.Effect<unknown>,
			),
		).toBe("t:sam:3");
	});

	it("resolves nothing for a name or an input it does not define", () => {
		expect(activities.resolve("unknown", { chat: "t" })).toBeUndefined();
		expect(activities.resolve("start/1", { chat: "t" })).toBeUndefined();
		expect(activities.resolve('reply/{"to":"sam"}', { chat: "t" })).toBeUndefined();
	});
});
