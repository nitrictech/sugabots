import type { ProjectChat } from "@sugabots/contracts";
import { listedChat } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	StoryApp,
	storyChatFor,
	storySecondChatFor,
	storyWorkspace,
} from "@/story-app.test-support.tsx";

/*
 * A bot's work as its page lists it on a phone, where the list has the screen
 * to itself: the chats that need the viewer, its open chats, and its resolved
 * ones folded at the foot. A wider screen shows the same list in the sidebar.
 */

const API = import.meta.env.VITE_API_URL as string;

const pricing: ProjectChat = storyChatFor(growthDesk);
const followUps: ProjectChat = storySecondChatFor(growthDesk);
const approvalWaiting: ProjectChat = {
	...pricing,
	id: "0199a3a0-0000-7000-8000-00000000e001",
	title: "Send the Northwind quote",
	updatedAt: "2026-09-18T07:00:00.000Z",
};
const resolvedChat: ProjectChat = {
	...pricing,
	id: "0199a3a0-0000-7000-8000-00000000e002",
	title: "March refund report",
	resolvedAt: "2026-09-17T12:00:00.000Z",
	updatedAt: "2026-09-17T12:00:00.000Z",
};

const botPage = `/${storyWorkspace.slug}/bots/${growthDesk.handle}`;
const chatsOfGrowthDesk = `${API}/projects/${growthDesk.defaultProjectId}/chats`;

const meta = preview.meta({
	title: "Product/Owner Work",
	parameters: { layout: "fullscreen" },
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={botPage} />,
});

/** Sorted shows a chat waiting on the viewer first, then the open chats, then the resolved one folded away. */
export const Sorted = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(chatsOfGrowthDesk, () =>
				HttpResponse.json({
					chats: [
						listedChat(pricing, { messageCount: 6 }),
						listedChat(followUps, { messageCount: 2 }),
						listedChat(approvalWaiting, { needsApproval: true }),
						listedChat(resolvedChat),
					],
					automations: [],
				}),
			),
			...appHandlers(),
		);
	},
	play: async ({ canvas, userEvent }) => {
		await expect(await canvas.findByRole("heading", { name: "Needs you" })).toBeInTheDocument();
		await expect(
			canvas.getByRole("link", { name: /^Send the Northwind quote.*needs your approval$/ }),
		).toBeInTheDocument();
		await expect(
			canvas.getByRole("link", { name: new RegExp(`^${pricing.title}`) }),
		).toBeInTheDocument();
		const resolved = canvas.getByRole("button", { name: /^Resolved/ });
		await expect(resolved).toHaveAttribute("aria-expanded", "false");
		const resolvedLink = { name: new RegExp(`^${resolvedChat.title}`) };
		await expect(canvas.queryByRole("link", resolvedLink)).toBeNull();
		await userEvent.click(resolved);
		await expect(canvas.getByRole("link", resolvedLink)).toBeInTheDocument();
	},
});

/** NoChatsYet is a bot nobody has talked to: the list says so rather than showing nothing. */
export const NoChatsYet = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(chatsOfGrowthDesk, () => HttpResponse.json({ chats: [], automations: [] })),
			...appHandlers(),
		);
	},
	play: async ({ canvas }) => {
		// The whole app renders, so the list can briefly show in more than one place.
		await expect((await canvas.findAllByText("No chats yet")).length).toBeGreaterThan(0);
	},
});

/** CouldNotLoad is a list the API failed to answer: the list says so where its chats would be. */
export const CouldNotLoad = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.get(chatsOfGrowthDesk, () => new HttpResponse(null, { status: 500 })),
			...appHandlers(),
		);
	},
	play: async ({ canvas }) => {
		// The app retries a failure the API didn't mean before it shows it.
		const notes = await canvas.findAllByText(
			"Could not load these chats.",
			{},
			{ timeout: 15_000 },
		);
		await expect(notes.length).toBeGreaterThan(0);
	},
});
