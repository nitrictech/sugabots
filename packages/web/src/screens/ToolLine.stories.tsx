import type { Message } from "@sugabots/contracts";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { WorkedFor } from "./ToolLine.tsx";

const message: Message = {
	id: "0199a3a0-0000-7000-8000-000000000610",
	chatId: "0199a3a0-0000-7000-8000-000000000611",
	author: {
		kind: "bot",
		id: "0199a3a0-0000-7000-8000-000000000612",
		name: "Issue Triager",
		handle: "issue-triager",
		color: "green",
		eyes: "arc",
		shape: "circle",
	},
	status: "complete",
	createdAt: "2026-09-22T04:30:00.000Z",
	finishedAt: "2026-09-22T04:30:03.000Z",
	content: "The changelog is temporarily unavailable.",
	parts: [
		{
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-000000000613",
			tool: "web_fetch",
			input: { url: "https://linear.app/changelog" },
			output: null,
			status: "failed",
			error: "The page returned an HTTP 503.",
			approval: null,
			atOffset: 0,
			startedAt: "2026-09-22T04:30:01.000Z",
			finishedAt: "2026-09-22T04:30:02.000Z",
		},
	],
};

const meta = preview.meta({
	title: "Product/ToolLine",
	component: WorkedFor,
	args: { message, markedConnectors: new Map(), fileNames: new Map(), className: "max-w-96" },
});

/** FailedCall shows the error a bot’s tool returned and lets a member inspect the input. */
export const FailedCall = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Worked for 3s" }));
		await userEvent.click(await canvas.findByRole("button", { name: /linear\.app/ }));
		const error = await canvas.findByRole("figure", { name: "Error" });
		await expect(error).toHaveTextContent("The page returned an HTTP 503.");
		await userEvent.click(canvas.getByRole("button", { name: "Show input" }));
		await expect(canvas.getByRole("figure", { name: "Input" })).toHaveTextContent(
			"https://linear.app/changelog",
		);
	},
});
