import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ConnectionMark } from "./connection-mark.tsx";

const SIZES = ["xs", "md", "sm", "tile", "default", "lg"] as const;

const meta = preview.meta({
	title: "Controls/ConnectionMark",
	component: ConnectionMark,
	tags: ["ai-generated"],
	args: { name: "Linear", presetId: "linear" },
});

/** Every size, from inline in a line of text to a connection page's heading. */
export const Sizes = meta.story({
	render: (args) => (
		<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
			{SIZES.map((size) => (
				<ConnectionMark key={size} {...args} size={size} />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		await expect(canvasElement.querySelectorAll("svg")).toHaveLength(SIZES.length);
	},
});

/** The catalog entries with a logo, each in its brand colour on a tint of it. */
export const Logos = meta.story({
	render: () => (
		<div style={{ display: "flex", gap: 14 }}>
			{["linear", "stripe", "notion", "sentry", "jira"].map((id) => (
				<ConnectionMark key={id} presetId={id} name={id} size="tile" />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		await expect(canvasElement.querySelectorAll("svg")).toHaveLength(5);
	},
});

/** Anything else: its letters on a neutral tile. */
export const Lettered = meta.story({
	render: () => (
		<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
			{SIZES.map((size) => (
				<ConnectionMark key={size} name="Team wiki" size={size} />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		await expect(canvasElement.querySelectorAll("svg")).toHaveLength(0);
		await expect(canvasElement.textContent).toContain("TW");
	},
});
