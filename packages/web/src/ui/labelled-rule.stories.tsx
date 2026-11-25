import preview from "#storybook/preview";
import { LabelledRule } from "./labelled-rule.tsx";

const meta = preview.meta({
	title: "Controls/LabelledRule",
	component: LabelledRule,
	args: { children: "Yesterday" },
});

/** NewDay marks where the next day’s chat messages start. */
export const NewDay = meta.story({
	args: { children: "Yesterday", className: "max-w-96" },
});
