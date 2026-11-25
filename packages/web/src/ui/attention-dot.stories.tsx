import preview from "#storybook/preview";
import { AttentionDot } from "./attention-dot.tsx";

const meta = preview.meta({
	title: "Controls/AttentionDot",
	component: AttentionDot,
	args: { attention: "needsYou", label: "Needs you" },
});

/** NeedsYou flags a chat that is waiting for the member. */
export const NeedsYou = meta.story({
	render: (args) => (
		<span className="flex items-center gap-2">
			<AttentionDot {...args} />
			Check Acme’s renewal quote
		</span>
	),
});
