import preview from "#storybook/preview";
import { TypingDots } from "./typing-dots.tsx";

const meta = preview.meta({
	title: "Controls/TypingDots",
	component: TypingDots,
});

/** Writing shows that a bot is working on a reply. */
export const Writing = meta.story({
	render: () => (
		<p className="flex items-center gap-2 text-sm">
			Issue Triager is writing <TypingDots />
		</p>
	),
});
