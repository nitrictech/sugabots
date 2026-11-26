import preview from "#storybook/preview";
import { Kbd } from "./kbd.tsx";

const meta = preview.meta({
	title: "Controls/Kbd",
	component: Kbd,
	tags: ["ai-generated"],
	args: { children: "Esc" },
});

/** One key, named beside what it does, such as Esc beside a button that exits. */
export const Key = meta.story({});

/** Keys pressed together, such as Ctrl+Shift+V beside a menu's Paste without formatting. */
export const KeysTogether = meta.story({ args: { children: "Ctrl+Shift+V" } });
