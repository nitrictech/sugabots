import type { NotificationLevel, NotificationSettings } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { storyBots } from "@/shell/story-fixtures.test-support.ts";
import { appHandlers, StoryApp, storyProjects, storyWorkspace } from "@/story-app.test-support.tsx";

const API = import.meta.env.VITE_API_URL as string;

const bot = storyBots.find((one) => !one.assistant);
const [project] = storyProjects;
if (!bot || !project) throw new Error("The story app has no bot or project");

/**
 * Right-clicks `row` until its notifications menu opens: a row only has the
 * menu once the member's notification settings have loaded.
 */
async function openMenuOf(row: Element) {
	await waitFor(async () => {
		await userEvent.pointer({ keys: "[MouseRight]", target: row });
		await waitFor(() => expect(screen.getByRole("menu")).toBeVisible());
	});
}

/**
 * Clicks a menu item that closes the menus, and waits until they have closed,
 * so the next step finds the page rather than the menu, or opens it afresh.
 */
async function chooseAndClose(item: HTMLElement) {
	await userEvent.click(item);
	await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

/*
 * Approvals, as a page with the whole sidebar: on a bot's or project's own pages
 * the sidebar narrows to their icons, which have no menu.
 */
const approvalsPath = `/${storyWorkspace.slug}/approvals`;

const meta = preview.meta({
	title: "Views/NotificationLevelMenu",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw, parameters }) {
		const inheritedMute = parameters.inheritedMute === true;
		let settings: NotificationSettings = {
			level: "mentions",
			pausedUntil: null,
			quietHours: null,
			turnFailures: true,
			automationRuns: "failures",
			projects: {},
			bots: inheritedMute ? { [bot.id]: "all" } : {},
			mutedUntil: {
				projects: {},
				bots: inheritedMute ? { [bot.id]: "2099-02-01T10:00:00.000Z" } : {},
			},
		};
		type Field = "projects" | "bots";
		const fieldOf = (kind: unknown): Field => (kind === "project" ? "projects" : "bots");
		const without = <T,>(record: Record<string, T>, id: string) => {
			const { [id]: _previous, ...others } = record;
			return others;
		};
		const mute = (field: Field, id: string, until: string | null) => {
			const others = without(settings.mutedUntil[field], id);
			settings = {
				...settings,
				mutedUntil: {
					...settings.mutedUntil,
					[field]: until ? { ...others, [id]: until } : others,
				},
			};
			return new HttpResponse(null, { status: 204 });
		};
		// Choosing a level ends a mute, as on the server.
		const choose = (field: Field, id: string, level: NotificationLevel | null) => {
			mute(field, id, null);
			const others = without(settings[field], id);
			settings = { ...settings, [field]: level ? { ...others, [id]: level } : others };
			return new HttpResponse(null, { status: 204 });
		};
		msw.use(
			http.get(`${API}/notifications`, () => HttpResponse.json(settings)),
			http.put(`${API}/notifications/:kind/:id/level`, async ({ params, request }) => {
				const { level } = (await request.json()) as { level: NotificationLevel | null };
				return choose(fieldOf(params.kind), String(params.id), level);
			}),
			http.put(`${API}/notifications/:kind/:id/mute`, async ({ params, request }) => {
				const { until } = (await request.json()) as { until: string | null };
				return mute(fieldOf(params.kind), String(params.id), until);
			}),
			...appHandlers(),
		);
	},
});

/**
 * Right-clicking a bot in the sidebar offers what it notifies about. Choosing
 * Nothing marks it muted, until it goes back to the member's default level.
 */
export const MutingABot = meta.story({
	render: () => <StoryApp path={approvalsPath} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const row = await sidebar.findByText(bot.name);
		await openMenuOf(row);
		await waitFor(() =>
			expect(screen.getByRole("group", { name: "Notify you about…" })).toBeVisible(),
		);
		await chooseAndClose(await screen.findByRole("menuitemradio", { name: "Nothing" }));
		await expect(await sidebar.findByRole("img", { name: "Muted" })).toBeVisible();

		await openMenuOf(row);
		await chooseAndClose(
			await screen.findByRole("menuitemradio", { name: "Default (mentions and replies)" }),
		);
		await waitFor(() => expect(sidebar.queryByRole("img", { name: "Muted" })).toBeNull());
	},
});

/**
 * Under More options, a bot muted for a while is marked muted until then,
 * and the same menu then offers to unmute it.
 */
export const MutingABotForAWhile = meta.story({
	render: () => <StoryApp path={approvalsPath} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const row = await sidebar.findByText(bot.name);
		await openMenuOf(row);
		await userEvent.click(await screen.findByRole("menuitem", { name: "More options" }));
		await chooseAndClose(await screen.findByRole("menuitem", { name: "Mute for 1 hour" }));
		await expect(await sidebar.findByRole("img", { name: /^Muted until / })).toBeVisible();

		await openMenuOf(row);
		await userEvent.click(await screen.findByRole("menuitem", { name: "More options" }));
		await chooseAndClose(await screen.findByRole("menuitem", { name: /^Unmute/ }));
		await waitFor(() => expect(sidebar.queryByRole("img", { name: /^Muted/ })).toBeNull());
	},
});

/** A bot's inherited mute is visible and ends when the member chooses Everything again. */
export const ClearingAnInheritedBotMute = meta.story({
	parameters: { inheritedMute: true },
	render: () => <StoryApp path={approvalsPath} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		await expect(await sidebar.findByRole("img", { name: /^Muted until / })).toBeVisible();
		await openMenuOf(await sidebar.findByText(bot.name));
		const everything = await screen.findByRole("menuitemradio", { name: "Everything" });
		await expect(everything).toHaveAttribute("aria-checked", "true");
		await chooseAndClose(everything);
		await waitFor(() => expect(sidebar.queryByRole("img", { name: /^Muted/ })).toBeNull());
	},
});

/** More options ends with the way to every notification setting. */
export const OpeningNotificationSettings = meta.story({
	render: () => <StoryApp path={approvalsPath} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const row = await sidebar.findByText(bot.name);
		await openMenuOf(row);
		await userEvent.click(await screen.findByRole("menuitem", { name: "More options" }));
		await chooseAndClose(await screen.findByRole("menuitem", { name: "Notification settings" }));
		await expect(await canvas.findByRole("heading", { name: "Notifications" })).toBeVisible();
	},
});
