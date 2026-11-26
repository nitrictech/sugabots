import type { NotificationPreferences, NotificationSettings } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyProjects, storyWorkspace } from "@/story-app.test-support.tsx";

const API = import.meta.env.VITE_API_URL as string;

const nothingChosen: NotificationSettings = {
	level: "mentions",
	pausedUntil: null,
	quietHours: null,
	turnFailures: true,
	automationRuns: "failures",
	projects: {},
	bots: {},
	mutedUntil: { projects: {}, bots: {} },
};

const [firstProject, secondProject] = storyProjects;

/** Somebody who hears of everything, but not from one project, and not overnight. */
const chosen: NotificationSettings = {
	level: "all",
	pausedUntil: null,
	quietHours: { from: "22:00", to: "07:30", timeZone: "Pacific/Auckland" },
	turnFailures: false,
	automationRuns: "all",
	projects: secondProject ? { [secondProject.id]: "nothing" } : {},
	bots: {},
	mutedUntil: { projects: {}, bots: {} },
};

/** Answers with `settings`, and with each change as the server would save it. */
const settingsHandlers = (settings: NotificationSettings) => {
	let current = settings;
	return [
		http.get(`${API}/notifications`, () => HttpResponse.json(current)),
		http.put(`${API}/notifications`, async ({ request }) => {
			current = { ...current, ...((await request.json()) as NotificationPreferences) };
			return HttpResponse.json(current);
		}),
	];
};

const meta = preview.meta({
	title: "Views/NotificationsSettings",
	parameters: { layout: "fullscreen" },
});

const page = () => <StoryApp path={`/${storyWorkspace.slug}?settings=notifications`} />;

/** NothingChosen is where everybody starts: mentions, replies and approvals, in every project. */
export const NothingChosen = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(nothingChosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		const level = await canvas.findByRole("group", { name: "Notify me about" });
		await expect(within(level).getByRole("radio", { name: "Mentions and replies" })).toBeChecked();
		await expect(canvas.getByText(/replies in chats you're part of/)).toBeInTheDocument();
		if (firstProject) {
			await expect(
				canvas.getByRole("button", { name: `Notifications for ${firstProject.name}` }),
			).toHaveTextContent("Default");
		}
	},
});

/** Choosing Everything says what it covers, and keeps the choice. */
export const ChoosingEverything = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(nothingChosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		const level = await canvas.findByRole("group", { name: "Notify me about" });
		await userEvent.click(within(level).getByRole("radio", { name: "Everything" }));
		await expect(
			await canvas.findByText(/Every new message in the chats you can see/),
		).toBeInTheDocument();
		await expect(within(level).getByRole("radio", { name: "Everything" })).toBeChecked();
	},
});

/** Chosen shows a project turned off and quiet hours overnight. */
export const Chosen = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(chosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		await expect(await canvas.findByLabelText("From", undefined)).toHaveValue("22:00");
		await expect(canvas.getByLabelText("To")).toHaveValue("07:30");
		if (secondProject) {
			await expect(
				canvas.getByRole("button", { name: `Notifications for ${secondProject.name}` }),
			).toHaveTextContent("Nothing");
		}
	},
});

/** Paused says until when, and Resume ends it. */
export const Paused = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...settingsHandlers({
				...nothingChosen,
				pausedUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
			}),
			...appHandlers(),
		);
	},
	render: page,
	play: async ({ canvas }) => {
		await expect(await canvas.findByText(/^Paused until/, undefined)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Resume" }));
		await expect(await canvas.findByRole("button", { name: "Pause" })).toBeInTheDocument();
	},
});

/** Besides messages, failed replies are on and only failed automation runs notify, until changed. */
export const ChoosingWhatElseNotifies = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(nothingChosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		const failedReplies = await canvas.findByRole("switch", {
			name: "A bot can't finish its reply to me",
		});
		await expect(failedReplies).toBeChecked();
		await userEvent.click(failedReplies);
		await waitFor(() => expect(failedReplies).not.toBeChecked());

		const automationRuns = canvas.getByRole("group", { name: "My automations run" });
		await expect(within(automationRuns).getByRole("radio", { name: "Failed" })).toBeChecked();
		await userEvent.click(within(automationRuns).getByRole("radio", { name: "Every run" }));
		await waitFor(() =>
			expect(within(automationRuns).getByRole("radio", { name: "Every run" })).toBeChecked(),
		);
	},
});
