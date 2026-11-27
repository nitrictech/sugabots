import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { formatDay } from "@/lib/list-time.ts";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyChatFor,
	storyMessage,
} from "@/story-app.test-support.tsx";

/*
 * A chat's messages in order: a bot's messages one after another drawn as one
 * run under its face, and each day behind a separator.
 */

const chatId = storyChatFor(growthDesk).id;
const firstDay = "2026-09-17T16:00:00.000Z";
const secondDay = "2026-09-18T06:04:00.000Z";

const meta = preview.meta({
	title: "Product/Chat Timeline",
	parameters: { layout: "fullscreen" },
	render: () => <StoryApp path={chatPath(growthDesk)} />,
});

/** AcrossDays puts each day's messages behind a separator naming the day. */
export const AcrossDays = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				messages: {
					[growthDesk.id]: [
						storyMessage({
							id: "b1",
							chatId,
							by: "you",
							text: "Queue tonight's outbound when you can.",
							at: firstDay,
						}),
						storyMessage({
							id: "b2",
							chatId,
							by: growthDesk,
							text: "Queued 38 leads for tonight.",
							at: "2026-09-17T16:01:00.000Z",
						}),
						storyMessage({
							id: "b3",
							chatId,
							by: growthDesk,
							text: "Overnight, six of them replied.",
							at: secondDay,
						}),
					],
				},
			}),
		);
	},
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(
			await within(log).findByText("Overnight, six of them replied."),
		).toBeInTheDocument();
		await expect(within(log).getByText(formatDay(new Date(firstDay)))).toBeInTheDocument();
		await expect(within(log).getByText(formatDay(new Date(secondDay)))).toBeInTheDocument();
	},
});

/** ARunOfMessages draws a bot's messages in a row under one face, not one face each. */
export const ARunOfMessages = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				messages: {
					[growthDesk.id]: ["Pricing replies are drafted.", "Both are short.", "Send?"].map(
						(text, index) =>
							storyMessage({
								id: `c${index}`,
								chatId,
								by: growthDesk,
								text,
								at: `2026-09-18T06:0${index}:00.000Z`,
							}),
					),
				},
			}),
		);
	},
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		const last = await within(log).findByText("Send?");
		const first = within(log).getByText("Pricing replies are drafted.");
		await expect(
			first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	},
});
