import type { RunTriggerKind } from "@sugabots/contracts";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { type ActivityState, ChatActivityRow } from "./ChatActivityRow.tsx";

const growthDesk = {
	kind: "bot" as const,
	id: "0199a3a0-0000-7000-8000-000000000401",
	name: "Growth Desk",
	handle: "growth-desk",
	color: "green" as const,
	face: "pill" as const,
	shape: "circle" as const,
};

const linearHandler = {
	kind: "bot" as const,
	id: "0199a3a0-0000-7000-8000-000000000402",
	name: "Linear Handler",
	handle: "linear-handler",
	color: "orange" as const,
	face: "dot" as const,
	shape: "circle" as const,
};

const meta = preview.meta({
	title: "Product/ChatActivityRow",
	component: ChatActivityRow,
	tags: ["ai-generated"],
});

const collaboration = (state: ActivityState, onOpen = fn()) => (
	<ChatActivityRow
		type="collaboration"
		initiator={growthDesk}
		recipient={linearHandler}
		state={state}
		onOpen={onOpen}
	/>
);

const automation = (state: ActivityState, triggerKind: RunTriggerKind = "schedule") => (
	<ChatActivityRow
		type="run"
		automationName="Overnight outbound"
		triggerKind={triggerKind}
		state={state}
		onOpen={fn()}
	/>
);

/** CollaborationRunning is the asked bot still helping the bot that asked it. */
export const CollaborationRunning = meta.story({ render: () => collaboration("running") });

const opened = fn();

/** CollaborationDone opens the collaboration when clicked. */
export const CollaborationDone = meta.story({
	render: () => collaboration("done", opened),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			canvas.getByRole("button", { name: /Linear Handler helped Growth Desk/ }),
		);
		await expect(opened).toHaveBeenCalled();
	},
});

/**
 * CollaborationWithWhatWasAsked follows the line with what the bot was asked,
 * cut short when it runs past the chat's width.
 */
export const CollaborationWithWhatWasAsked = meta.story({
	render: () => (
		<div className="w-xl max-w-full">
			<ChatActivityRow
				type="collaboration"
				initiator={growthDesk}
				recipient={linearHandler}
				title="Check which of last week's signups came through the partner referral links"
				state="running"
				onOpen={fn()}
			/>
		</div>
	),
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("button", {
				name: /Linear Handler is helping Growth Desk, Check which of last week's signups/,
			}),
		).toBeInTheDocument();
	},
});

/** AutomationRan is a scheduled automation that posted into the chat, marked with a clock. */
export const AutomationRan = meta.story({ render: () => automation("done") });

/** AutomationRanFromWebhook is a run its webhook started, marked with a hook in the clock's place. */
export const AutomationRanFromWebhook = meta.story({ render: () => automation("done", "webhook") });

/** AutomationFailed marks the failure with the one red the design allows. */
export const AutomationFailed = meta.story({ render: () => automation("failed") });
