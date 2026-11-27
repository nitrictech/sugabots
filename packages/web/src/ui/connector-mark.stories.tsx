import { Globe } from "lucide-react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ConnectorMark } from "./connector-mark.tsx";

const SIZES = ["xs", "md", "sm", "tile", "default", "lg"] as const;

const meta = preview.meta({
	title: "Controls/ConnectorMark",
	component: ConnectorMark,
	tags: ["ai-generated"],
	args: { name: "Linear", markId: "linear" },
});

/** Every size, from inline in a line of text to a connector page's heading. */
export const Sizes = meta.story({
	render: (args) => (
		<div className="flex items-center gap-3.5">
			{SIZES.map((size) => (
				<ConnectorMark key={size} {...args} size={size} />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		await expect(canvasElement.querySelectorAll("svg")).toHaveLength(SIZES.length);
	},
});

/** The built-in connectors with a logo, each in its brand colour on a tint of it. */
export const Logos = meta.story({
	render: () => (
		<div className="flex gap-3.5">
			{["linear", "stripe", "notion", "sentry", "jira"].map((id) => (
				<ConnectorMark key={id} markId={id} name={id} size="tile" />
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
		<div className="flex items-center gap-3.5">
			{SIZES.map((size) => (
				<ConnectorMark key={size} name="Team wiki" size={size} />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		await expect(canvasElement.querySelectorAll("svg")).toHaveLength(0);
		await expect(canvasElement.textContent).toContain("TW");
	},
});

/** A step that reaches no connector, such as a computer asking to reach a host: an icon on the neutral tile. */
export const WithAnIcon = meta.story({
	render: () => (
		<div className="flex items-center gap-3.5">
			{SIZES.map((size) => (
				<ConnectorMark key={size} name="Host request" icon={Globe} size={size} />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		await expect(canvasElement.querySelectorAll("svg")).toHaveLength(SIZES.length);
		await expect(canvasElement.textContent).not.toContain("NR");
	},
});
