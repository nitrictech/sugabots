import { Context, Effect, Schema } from "effect";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { Activities } from "./activities.ts";

interface Thread {
	readonly thread: string;
}

class Steps extends Context.Service<
	Steps,
	{
		readonly start: (payload: Thread) => Effect.Effect<void>;
		readonly reply: (
			payload: Thread,
			input: { readonly to: string; readonly round: number },
		) => Effect.Effect<string>;
	}
>()("test/Steps") {}

const activities = Activities.fromService<Thread>()(Steps, {
	start: {},
	reply: {
		input: Schema.Struct({ to: Schema.String, round: Schema.Finite }),
		success: Schema.String,
	},
});

const Replying = Workflow.make("test/replying", {
	payload: { thread: Schema.String },
	idempotencyKey: (payload) => payload.thread,
});

const steps = Steps.of({
	start: () => Effect.void,
	reply: ({ thread }, { to, round }) => Effect.succeed(`${thread}:${to}:${round}`),
});

describe("activity definitions", () => {
	it("names an activity by its method and input", () => {
		expect(activities.activity("start", { thread: "t" }).name).toBe("start");
		expect(activities.activity("reply", { thread: "t" }, { to: "sam", round: 3 }).name).toBe(
			'reply/{"to":"sam","round":3}',
		);
	});

	it("rebuilds an activity from its full name and the payload, with its input", async () => {
		const rebuilt = activities.resolve('reply/{"to":"sam","round":3}', { thread: "t" });

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
		expect(activities.resolve("unknown", { thread: "t" })).toBeUndefined();
		expect(activities.resolve("start/1", { thread: "t" })).toBeUndefined();
		expect(activities.resolve('reply/{"to":"sam"}', { thread: "t" })).toBeUndefined();
	});
});
