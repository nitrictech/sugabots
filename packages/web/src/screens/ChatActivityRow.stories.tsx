import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { type ActivityState, ChatActivityRow } from "./ChatActivityRow.tsx";

const growthDesk = {
	kind: "agent" as const,
	id: "0199a3a0-0000-7000-8000-000000000401",
	name: "Growth Desk",
	handle: "growth-desk",
	color: "green" as const,
	face: "pill" as const,
};

const linearHandler = {
	kind: "agent" as const,
	id: "0199a3a0-0000-7000-8000-000000000402",
	name: "Linear Handler",
	handle: "linear-handler",
	color: "orange" as const,
	face: "dot" as const,
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

const routine = (state: ActivityState) => (
	<ChatActivityRow type="routine" routineName="Overnight outbound" state={state} onOpen={fn()} />
);

/** CollaborationRunning is the host bot still talking to the other; it says nothing else meanwhile. */
export const CollaborationRunning = meta.story({ render: () => collaboration("running") });

/** CollaborationWaitingOnYou is a collaboration stopped on an approval. */
export const CollaborationWaitingOnYou = meta.story({
	render: () => collaboration("waiting_on_you"),
});

const opened = fn();

/** CollaborationDone opens the collaboration when clicked. */
export const CollaborationDone = meta.story({
	render: () => collaboration("done", opened),
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(
			canvas.getByRole("button", { name: /Growth Desk collaborated with Linear Handler/ }),
		);
		await expect(opened).toHaveBeenCalled();
	},
});

/** In the chat of the bot that was asked, the same collaboration says it helped. */
export const CollaborationInTheAskedBotsChat = meta.story({
	render: () => (
		<ChatActivityRow
			type="collaboration"
			initiator={growthDesk}
			recipient={linearHandler}
			inChatOf="recipient"
			state="done"
			onOpen={fn()}
		/>
	),
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("button", { name: /Linear Handler helped Growth Desk/ }),
		).toBeInTheDocument();
	},
});

/** RoutineRan is a routine that posted into the chat. */
export const RoutineRan = meta.story({ render: () => routine("done") });

/** RoutineFailed marks the failure with the one red the design allows. */
export const RoutineFailed = meta.story({ render: () => routine("failed") });
