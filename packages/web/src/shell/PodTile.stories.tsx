import type { BotLook } from "@sugabots/avatars";
import { podColors } from "@sugabots/contracts";
import preview from "#storybook/preview";
import { PodTile, type PodTileSize } from "./PodTile.tsx";

const revenue: BotLook[] = [
	{ color: "green", face: "pill" },
	{ color: "orange", face: "arc" },
	{ color: "sky", face: "dot" },
	{ color: "yellow", face: "wink" },
	{ color: "rose", face: "square" },
];

const sizes: PodTileSize[] = [88, 72, 46, 44, 36, 28, 20];

const meta = preview.meta({
	title: "Product/PodTile",
	component: PodTile,
	tags: ["ai-generated"],
	args: { bots: revenue, color: "green" as const, size: 46 as const },
});

/** Default is a pod on the rail: its first four bots' faces, each with its own colour and eyes, on the pod's colour. */
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

/** Empty is a new pod with no bots yet: four faint discs. */
export const Empty = meta.story({
	args: { bots: [] },
});

/** Neutral is the uncoloured tile that All and a Personal pod are drawn on. */
export const Neutral = meta.story({
	args: { color: null },
});

/** Colours shows every pod colour, empty and with a bot in it, as a rail of pods would. */
export const Colours = meta.story({
	render: () => (
		<div className="flex flex-col gap-3">
			{[[], revenue.slice(0, 1)].map((bots) => (
				<div key={bots.length} className="flex gap-3">
					{podColors.map((color) => (
						<PodTile key={color} bots={bots} color={color} size={46} />
					))}
				</div>
			))}
		</div>
	),
});

/** Sizes shows the tile at every size the design draws, from the dialog preview down to the chat-row badge. */
export const Sizes = meta.story({
	render: () => (
		<div className="flex items-end gap-4">
			{sizes.map((size) => (
				<PodTile key={size} bots={revenue} color="green" size={size} />
			))}
		</div>
	),
});
