import { botColorVariables } from "@sugabots/avatars";
import preview from "#storybook/preview";
import { LiveDot } from "./live-dot.tsx";

const meta = preview.meta({
	title: "Controls/LiveDot",
	component: LiveDot,
});

/** Browsing marks the bot’s desktop as live. */
export const Browsing = meta.story({
	render: () => (
		<p className="flex items-center gap-2 text-sm" style={botColorVariables("green")}>
			<LiveDot /> Growth Desk is using its browser
		</p>
	),
});
