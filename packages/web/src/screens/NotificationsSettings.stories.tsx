import type { NotificationPreferences, NotificationSettings } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, StoryApp, storyPods, storyWorkspace } from "@/story-app.tsx";

const API = import.meta.env.VITE_API_URL as string;

const nothingChosen: NotificationSettings = {
	level: "mentions",
	pausedUntil: null,
	quietHours: null,
	turnFailures: true,
	routineRuns: "failures",
	pods: {},
	bots: {},
	mutedUntil: { pods: {}, bots: {} },
};

const [firstPod, secondPod] = storyPods;

/** Somebody who hears of everything, but not from one pod, and not overnight. */
const chosen: NotificationSettings = {
	level: "all",
	pausedUntil: null,
	quietHours: { from: "22:00", to: "07:30", timeZone: "Pacific/Auckland" },
	turnFailures: false,
	routineRuns: "all",
	pods: secondPod ? { [secondPod.id]: "nothing" } : {},
	bots: {},
	mutedUntil: { pods: {}, bots: {} },
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

const page = () => <StoryApp path={`/${storyWorkspace.slug}/settings/notifications`} />;

/** NothingChosen is where everybody starts: mentions, replies and approvals, in every pod. */
export const NothingChosen = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(nothingChosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		const level = await canvas.findByRole(
			"group",
			{ name: "Notify me about" },
			{ timeout: 10_000 },
		);
		await expect(within(level).getByRole("radio", { name: "Mentions and replies" })).toBeChecked();
		await expect(canvas.getByText(/replies in conversations you're part of/)).toBeInTheDocument();
		if (firstPod) {
			await expect(
				canvas.getByRole("button", { name: `Notifications for ${firstPod.name}` }),
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
		const level = await canvas.findByRole(
			"group",
			{ name: "Notify me about" },
			{ timeout: 10_000 },
		);
		await userEvent.click(within(level).getByRole("radio", { name: "Everything" }));
		await expect(
			await canvas.findByText(/Every new message in the conversations you can see/),
		).toBeInTheDocument();
		await expect(within(level).getByRole("radio", { name: "Everything" })).toBeChecked();
	},
});

/** Chosen shows a pod turned off and quiet hours overnight. */
export const Chosen = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(chosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		await expect(await canvas.findByLabelText("From", undefined, { timeout: 10_000 })).toHaveValue(
			"22:00",
		);
		await expect(canvas.getByLabelText("To")).toHaveValue("07:30");
		if (secondPod) {
			await expect(
				canvas.getByRole("button", { name: `Notifications for ${secondPod.name}` }),
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
		await expect(
			await canvas.findByText(/^Paused until/, undefined, { timeout: 10_000 }),
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Resume" }));
		await expect(await canvas.findByRole("button", { name: "Pause" })).toBeInTheDocument();
	},
});

/** Besides messages, failed replies are on and only failed routine runs notify, until changed. */
export const ChoosingWhatElseNotifies = meta.story({
	beforeEach({ msw }) {
		msw.use(...settingsHandlers(nothingChosen), ...appHandlers());
	},
	render: page,
	play: async ({ canvas }) => {
		const failedReplies = await canvas.findByRole(
			"switch",
			{ name: "A bot can't finish its reply to me" },
			{ timeout: 10_000 },
		);
		await expect(failedReplies).toBeChecked();
		await userEvent.click(failedReplies);
		await waitFor(() => expect(failedReplies).not.toBeChecked());

		const routineRuns = canvas.getByRole("group", { name: "My routines run" });
		await expect(within(routineRuns).getByRole("radio", { name: "Failed" })).toBeChecked();
		await userEvent.click(within(routineRuns).getByRole("radio", { name: "Every run" }));
		await waitFor(() =>
			expect(within(routineRuns).getByRole("radio", { name: "Every run" })).toBeChecked(),
		);
	},
});
