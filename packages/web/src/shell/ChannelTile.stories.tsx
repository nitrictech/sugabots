import type { BotLook } from "@sugabots/avatars";
import { channelColors } from "@sugabots/contracts";
import preview from "#storybook/preview";
import { ChannelTile, type ChannelTileSize } from "./ChannelTile.tsx";

const revenue: BotLook[] = [
	{ color: "green", face: "pill" },
	{ color: "orange", face: "arc" },
	{ color: "sky", face: "dot" },
	{ color: "yellow", face: "wink" },
	{ color: "rose", face: "square" },
];

const sizes: ChannelTileSize[] = [88, 72, 44, 36, 28];

const meta = preview.meta({
	title: "Product/ChannelTile",
	component: ChannelTile,
	tags: ["ai-generated"],
	args: { bots: revenue, color: "green" as const, size: 44 as const },
});

/** Default is a channel in settings: its first four bots' faces, each with its own colour and eyes, on the channel's colour. */
export const Default = meta.story({});

/** Partial fills the slots with no bot with faint discs. */
export const Partial = meta.story({
	args: {
		bots: [
			{ color: "purple", face: "wink" },
			{ color: "teal", face: "pill" },
		],
	},
});

/** Empty is a new channel with no bots yet: four faint discs. */
export const Empty = meta.story({
	args: { bots: [] },
});

/** Neutral is the uncoloured tile, drawn with no colour of its own. */
export const Neutral = meta.story({
	args: { color: null },
});

/** Colours shows every channel colour, empty and with a bot in it, as a list of channels would. */
export const Colours = meta.story({
	render: () => (
		<div className="flex flex-col gap-3">
			{[[], revenue.slice(0, 1)].map((bots) => (
				<div key={bots.length} className="flex gap-3">
					{channelColors.map((color) => (
						<ChannelTile key={color} bots={bots} color={color} size={44} />
					))}
				</div>
			))}
		</div>
	),
});

/** Sizes shows the tile at every size the design draws, from the dialog preview down to the new-bot picker. */
export const Sizes = meta.story({
	render: () => (
		<div className="flex items-end gap-4">
			{sizes.map((size) => (
				<ChannelTile key={size} bots={revenue} color="green" size={size} />
			))}
		</div>
	),
});
