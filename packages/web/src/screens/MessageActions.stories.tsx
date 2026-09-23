import type { ToolCallPart } from "@sugabots/contracts";
import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import type { ConnectionLook } from "@/lib/connections.ts";
import { MessageActions } from "./MessageActions.tsx";
import { toolActivityOf } from "./tool-activity.ts";

const looks = new Map<string, ConnectionLook>([
	["sentry", { name: "Sentry", presetId: "sentry", hue: 350 }],
]);

const START = Date.parse("2026-09-18T09:00:00.000Z");

function call(id: string): ToolCallPart {
	return {
		type: "tool_call",
		id,
		tool: "sentry__search_issues",
		input: { query: "timeout" },
		output: { issues: 3 },
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: new Date(START).toISOString(),
		finishedAt: new Date(START + 1_400).toISOString(),
	};
}

const threeSteps = toolActivityOf(
	{
		parts: [
			call("0199a3a0-0000-7000-8000-000000000001"),
			call("0199a3a0-0000-7000-8000-000000000002"),
			call("0199a3a0-0000-7000-8000-000000000003"),
		],
	},
	new Map([["sentry", "Sentry"]]),
);

const meta = preview.meta({
	title: "Product/MessageActions",
	component: MessageActions,
	tags: ["ai-generated"],
	args: { text: "Three things are live in Suga prod.", looks },
	decorators: [
		(Story) => (
			// `group/message` is what the bar fades in against; in the thread it is
			// the message's own article.
			<div className="group/message mx-auto flex max-w-home items-end justify-start gap-1.5 py-8">
				<span className="rounded-4xl bg-muted px-5 py-3.5 text-base">
					Three things are live in Suga prod.
				</span>
				<Story />
			</div>
		),
	],
});

/**
 * With tool calls behind it. The bar is transparent until the pointer or the
 * keyboard reaches it, so hover the message to see it.
 */
export const WithActivity = meta.story({ args: { activity: threeSteps } });

/** A reply that used no tools keeps copy, and offers no way into an empty log. */
export const WithoutActivity = meta.story({
	args: { activity: toolActivityOf({ parts: [{ type: "text", text: "Just words." }] }) },
});

/** The only way to the steps must be reachable without a pointer. */
export const ReachedByKeyboard = meta.story({
	args: { activity: threeSteps },
	play: async ({ canvas, userEvent }) => {
		await userEvent.tab();
		await expect(canvas.getByRole("button", { name: "Copy message" })).toHaveFocus();

		await userEvent.tab();
		const steps = canvas.getByRole("button", { name: "Show activity · 3 steps" });
		await expect(steps).toHaveFocus();
		// The bar fades in, so give the transition a moment before reading it.
		await waitFor(() => expect(steps).toBeVisible());
	},
});
