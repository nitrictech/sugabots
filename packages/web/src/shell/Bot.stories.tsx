import { type BotMood, botColorVariables, botMoods, type LivelyFace } from "@sugabots/avatars";
import { botColors, botEyes, botShapes } from "@sugabots/contracts";
import { useRef, useState } from "react";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { Button } from "@/ui/button.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { BotAvatar } from "./Bot.tsx";

const meta = preview.meta({
	title: "Product/BotAvatar",
	component: BotAvatar,
	tags: ["ai-generated"],
	args: { color: "green" as const, eyes: "pill" as const, shape: "circle" as const, size: 44 },
});

/** Default shows one bot's face at the list-row size. */
export const Default = meta.story({});

/** Palette shows every colour with every eye style, for checking faces and eyes against the design. */
export const Palette = meta.story({
	render: () => (
		<div
			className="grid w-fit items-center gap-3"
			style={{ gridTemplateColumns: "auto repeat(6, 44px)" }}
		>
			<span />
			{botEyes.map((eyes) => (
				<span key={eyes} className="text-center text-subtle-foreground text-xs">
					{eyes}
				</span>
			))}
			{botColors.map((color) => (
				<div key={color} className="contents">
					<span className="pr-2 text-subtle-foreground text-xs">{color}</span>
					{botEyes.map((eyes) => (
						<BotAvatar key={eyes} color={color} eyes={eyes} shape="circle" size={44} />
					))}
				</div>
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		const faces = canvasElement.querySelectorAll('svg > g[fill] > circle[r="20"]');
		await expect(faces).toHaveLength(botColors.length * botEyes.length);
	},
});

/** Bubbles shows each colour's tint with its text and inline mono, as a bot's message draws them. */
export const Bubbles = meta.story({
	render: () => (
		<div className="flex flex-col gap-2" style={{ maxWidth: 520 }}>
			{botColors.map((color) => (
				<div key={color} style={botColorVariables(color)} className="flex items-end gap-2 text-sm">
					<BotAvatar color={color} eyes="pill" shape="circle" size={34} />
					<p
						className="m-0 rounded-bubble bg-bot-tint text-bot-text"
						style={{ padding: "9px 15px" }}
					>
						Filed it as <span className="font-mono text-bot-mono text-xs">PLAT-482</span> for{" "}
						{color}.
					</p>
				</div>
			))}
		</div>
	),
});

/** Sizes shows the face at the sizes the design draws it. */
export const Sizes = meta.story({
	render: () => (
		<div className="flex items-end gap-4">
			{[26, 34, 40, 44, 60, 80, 96].map((size) => (
				<BotAvatar key={size} color="purple" eyes="arc" shape="squircle" size={size} />
			))}
		</div>
	),
});

/** Shapes shows every head shape, each in the next colour round the palette, for checking outlines and eyes against the design. */
export const Shapes = meta.story({
	render: () => (
		<div className="grid w-fit grid-cols-7 gap-4">
			{botShapes.map((shape, index) => (
				<figure key={shape} className="m-0 flex flex-col items-center gap-1.5">
					<BotAvatar
						color={botColors[index % botColors.length] ?? "green"}
						eyes="pill"
						shape={shape}
						size={56}
					/>
					<figcaption className="text-subtle-foreground text-xs">{shape}</figcaption>
				</figure>
			))}
		</div>
	),
	play: async ({ canvas }) => {
		for (const shape of botShapes) await expect(canvas.getByText(shape)).toBeVisible();
	},
});

/** Stacked overlaps ringed faces, as a row of participants does: each ring follows its head's shape. */
export const Stacked = meta.story({
	render: () => (
		<div className="flex rounded-panel bg-panel p-4">
			{(["star", "hexagon", "bear", "ghost"] as const).map((shape, index) => (
				<BotAvatar
					key={shape}
					color={botColors[index] ?? "green"}
					eyes="dot"
					shape={shape}
					size={44}
					ringed={{ color: "var(--panel)", width: 3 }}
					className="-mr-3"
				/>
			))}
		</div>
	),
});

/** A mood's name as a label: `idle` reads "Idle". */
function moodLabel(mood: BotMood): string {
	return mood.charAt(0).toUpperCase() + mood.slice(1);
}

const moodOptions = botMoods.map((mood) => ({ value: mood, label: moodLabel(mood) }));

/** Lively shows every head shape alive, for trying each mood, how one eases into the next, and a hop. */
export const Lively = meta.story({
	globals: { liveliness: "sometimes" },
	render: function Render() {
		const faces = useRef<(LivelyFace | null)[]>([]);
		const [mood, setMood] = useState<BotMood>("idle");
		return (
			<div className="flex flex-col items-start gap-6 pt-6">
				<div className="flex items-center gap-3">
					<Button
						onClick={() => {
							for (const eyes of faces.current) eyes?.hop();
						}}
					>
						Hop
					</Button>
					<RadioGroup aria-label="Mood" value={mood} onValueChange={setMood}>
						{moodOptions.map((option) => (
							<RadioGroupItem key={option.value} value={option.value}>
								{option.label}
							</RadioGroupItem>
						))}
					</RadioGroup>
				</div>
				<div className="grid w-fit grid-cols-7 gap-6">
					{botShapes.map((shape, index) => (
						<BotAvatar
							key={shape}
							color={botColors[index % botColors.length] ?? "green"}
							eyes={botEyes[index % botEyes.length]}
							shape={shape}
							size={80}
							lively={{
								mood,
								ref: (eyes) => {
									faces.current[index] = eyes;
								},
							}}
						/>
					))}
				</div>
			</div>
		);
	},
});

/** Moods shows a bot in each mood side by side, for comparing them. */
export const Moods = meta.story({
	globals: { liveliness: "sometimes" },
	render: () => (
		<div className="flex gap-8 pt-6">
			{botMoods.map((mood, index) => (
				<figure key={mood} className="m-0 flex flex-col items-center gap-3">
					<BotAvatar
						color={botColors[index % botColors.length] ?? "green"}
						eyes={botEyes[index % botEyes.length]}
						shape={botShapes[index % botShapes.length] ?? "circle"}
						size={96}
						lively={{ mood }}
					/>
					<figcaption className="text-subtle-foreground text-xs">{moodLabel(mood)}</figcaption>
				</figure>
			))}
		</div>
	),
	play: async ({ canvas }) => {
		for (const mood of botMoods) await expect(canvas.getByText(moodLabel(mood))).toBeVisible();
	},
});

/** OneLively shows a single lively face, for judging one mood by itself, or what one face costs. */
export const OneLively = meta.story({
	globals: { liveliness: "sometimes" },
	args: { size: 96, lively: { mood: "idle" } },
});
