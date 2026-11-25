import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	StoryApp,
	storyProjectChatFor,
	storyWorkspace,
} from "@/story-app.test-support.tsx";
import { automationRun, RUN } from "./NestedChatPanel.test-support.ts";

const parent = storyProjectChatFor(revenue);
const run = automationRun(false, parent.id);

const meta = preview.meta({
	title: "Views/Nested Chat Page",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${import.meta.env.VITE_API_URL}/chats/${RUN}`, () => HttpResponse.json(run)),
			...appHandlers(),
		);
	},
});

/** RunFromNotification opens an automation run directly from the address in its notification. */
export const RunFromNotification = meta.story({
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/projects/${revenue.slug}/${parent.id}?nestedChatPage=${RUN}`}
		/>
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Overnight outbound" })).toBeVisible();
		const log = within(await canvas.findByRole("log", { name: "Run messages" }));
		await expect(log.getByText(/Queued 38 leads/)).toBeInTheDocument();
	},
});
