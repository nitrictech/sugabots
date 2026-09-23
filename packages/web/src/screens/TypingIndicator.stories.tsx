import preview from "#storybook/preview";
import { TypingIndicator } from "./TypingIndicator.tsx";

const agent = { name: "Personal Assistant", hue: 210, face: "bar" as const };

const meta = preview.meta({
	title: "Product/TypingIndicator",
	component: TypingIndicator,
	tags: ["ai-generated"],
	args: { agent },
	decorators: [
		(Story) => (
			<div className="mx-auto max-w-home py-4">
				<Story />
			</div>
		),
	],
});

/** The agent's turn is running and its reply is not finished yet. */
export const Typing = meta.story({});

/** Asked another agent, and waiting to hear back. */
export const WaitingOnACollaborator = meta.story({ args: { waitingOn: "Issue Triager" } });

/** On the side the agent's own bubbles are on, in a one-to-one chat. */
export const OnTheAgentsSide = meta.story({ args: { outgoing: true } });
