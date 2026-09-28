import type { ThreadContext } from "@sugabots/contracts";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { ContextMeter } from "./ContextMeter.tsx";

const NOW = new Date("2026-09-28T09:30:00.000Z");

const context = (usedTokens: number, compactedAt: string | null = null): ThreadContext => ({
	usedTokens,
	measuredAt: "2026-09-28T09:05:00.000Z",
	windowTokens: 256_000,
	compactionLineTokens: 179_200,
	compactedAt,
});

const meta = preview.meta({
	title: "Product/ContextMeter",
	component: ContextMeter,
	tags: ["ai-generated"],
	args: { context: context(48_200), now: NOW },
	decorators: [
		(Story) => (
			<div className="w-[320px] overflow-hidden rounded-panel bg-panel">
				<Story />
			</div>
		),
	],
});

/** Filling is a chat well short of the line, where the bot still reads all of it. */
export const Filling = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("meter", { name: "Short-term memory used" })).toHaveAttribute(
			"value",
			"19",
		);
		await expect(canvas.getByText("19% full")).toBeVisible();
		await expect(canvas.getByText("Compacts at 70%.")).toBeVisible();
		await expect(canvas.queryByText(/tokens/)).toBeNull();
	},
});

/** PastTheLine is a chat the latest reply took over the line, so it is being compacted. */
export const PastTheLine = meta.story({
	args: { context: context(186_400) },
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/Past 70%/)).toBeVisible();
	},
});

/** Compacted is a chat the bot now reads as a summary and its newest messages. */
export const Compacted = meta.story({
	args: { context: context(71_900, "2026-09-28T08:12:00.000Z") },
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/Last compacted at/)).toBeVisible();
	},
});

/** CompactedSinceMeasured is a chat compacted after its latest reply, so the figure waits for the next. */
export const CompactedSinceMeasured = meta.story({
	args: { context: context(186_400, "2026-09-28T09:06:00.000Z") },
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/this updates after the next reply/)).toBeVisible();
		await expect(canvas.queryByText(/Past 70%/)).toBeNull();
	},
});
