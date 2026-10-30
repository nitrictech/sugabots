import type { NotificationLevel, NotificationSettings } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { appHandlers, chatPath, StoryApp, storyBots, storyPods } from "@/story-app.tsx";

const API = import.meta.env.VITE_API_URL as string;

const [bot] = storyBots;
const pod = storyPods.find((one) => one.id === bot?.podId);
if (!bot || !pod) throw new Error("The story app has no bot in a pod");

/**
 * Right-clicks `row` until its notifications menu opens: a row only has the
 * menu once the person's notification settings have loaded.
 */
async function openMenuOf(row: Element) {
	await waitFor(
		async () => {
			await userEvent.pointer({ keys: "[MouseRight]", target: row });
			await expect(screen.getByRole("menu")).toBeVisible();
		},
		{ timeout: 10_000 },
	);
}

const meta = preview.meta({
	title: "Views/NotificationLevelMenu",
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		let settings: NotificationSettings = {
			level: "mentions",
			pausedUntil: null,
			quietHours: null,
			turnFailures: true,
			routineRuns: "failures",
			pods: {},
			bots: {},
			mutedUntil: { pods: {}, bots: {} },
		};
		type Field = "pods" | "bots";
		const fieldOf = (kind: unknown): Field => (kind === "pod" ? "pods" : "bots");
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
 * Nothing marks it muted, until it goes back to following its pod.
 */
export const MutingABot = meta.story({
	render: () => <StoryApp path={chatPath(bot)} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const row = await sidebar.findByText(bot.name, {}, { timeout: 10_000 });
		await openMenuOf(row);
		await expect(await screen.findByRole("group", { name: "Notify you about…" })).toBeVisible();
		await userEvent.click(await screen.findByRole("menuitemradio", { name: "Nothing" }));
		await expect(await sidebar.findByRole("img", { name: "Muted" })).toBeVisible();

		await openMenuOf(row);
		await userEvent.click(
			await screen.findByRole("menuitemradio", { name: "Default (mentions and replies)" }),
		);
		await expect(sidebar.queryByRole("img", { name: "Muted" })).toBeNull();
	},
});

/**
 * Under More options, a bot muted for a while is marked muted until then,
 * and the same menu then offers to unmute it.
 */
export const MutingABotForAWhile = meta.story({
	render: () => <StoryApp path={chatPath(bot)} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const row = await sidebar.findByText(bot.name, {}, { timeout: 10_000 });
		await openMenuOf(row);
		await userEvent.click(await screen.findByRole("menuitem", { name: "More options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Mute for 1 hour" }));
		await expect(await sidebar.findByRole("img", { name: /^Muted until / })).toBeVisible();

		await openMenuOf(row);
		await userEvent.click(await screen.findByRole("menuitem", { name: "More options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /^Unmute/ }));
		await expect(sidebar.queryByRole("img", { name: /^Muted/ })).toBeNull();
	},
});

/** More options ends with the way to every notification setting. */
export const OpeningNotificationSettings = meta.story({
	render: () => <StoryApp path={chatPath(bot)} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const row = await sidebar.findByText(bot.name, {}, { timeout: 10_000 });
		await openMenuOf(row);
		await userEvent.click(await screen.findByRole("menuitem", { name: "More options" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: "Notification settings" }));
		await expect(await canvas.findByRole("heading", { name: "Notifications" })).toBeVisible();
		// Done once the menus have finished closing, whose focus guards the accessibility check
		// that follows would otherwise find while a busy machine is still animating them away.
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	},
});

/**
 * A pod's menu chooses its level, and a bot in it then defaults to the pod's
 * rather than the person's own.
 */
export const ChoosingAPodsLevel = meta.story({
	render: () => <StoryApp path={chatPath(bot)} />,
	play: async ({ canvas }) => {
		const sidebar = within(await canvas.findByRole("navigation", { name: "Sidebar" }));
		const podRow = within(await sidebar.findByRole("group", { name: pod.name })).getByRole(
			"button",
			{ name: pod.name },
		);
		await openMenuOf(podRow);
		await userEvent.click(await screen.findByRole("menuitemradio", { name: "Everything" }));

		await openMenuOf(sidebar.getByText(bot.name));
		await expect(
			await screen.findByRole("menuitemradio", { name: "Default (everything)" }),
		).toHaveAttribute("aria-checked", "true");
	},
});
