import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
import { expect, fn, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { TimeZoneDialog } from "./TimeZoneDialog.tsx";

const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const timeZoneUrl = `${import.meta.env.VITE_API_URL}/workspaces/${WORKSPACE_ID}/time-zone`;

/** What the API was asked to move the workspace to. */
const movedTo = fn<(timeZone: unknown) => void>();

const answering = (scheduledRoutines: number) => [
	http.get(timeZoneUrl, () =>
		HttpResponse.json({ timeZone: "Australia/Sydney", scheduledRoutines }),
	),
	http.put(timeZoneUrl, async ({ request }) => {
		movedTo(((await request.json()) as { timeZone: unknown }).timeZone);
		return new HttpResponse(null, { status: 204 });
	}),
];

function QueryPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Views/TimeZoneDialog",
	component: TimeZoneDialog,
	args: {
		workspaceId: WORKSPACE_ID,
		current: "Australia/Sydney",
		open: true,
		onOpenChange: fn(),
	},
	parameters: {
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "720px" } },
	},
	decorators: [
		(Story, context) => (
			<QueryPreview key={context.id}>
				<Story />
			</QueryPreview>
		),
	],
	beforeEach({ msw }) {
		movedTo.mockClear();
		msw.use(...answering(0));
	},
});

const dialogOf = (canvasElement: HTMLElement) =>
	within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Time zone" });

/**
 * Every zone, with this device's first and the workspace's marked. Found by
 * typing part of its name, and saved once it is another.
 */
export const Choosing = meta.story({
	play: async ({ args, canvasElement, userEvent }) => {
		const dialog = within(await dialogOf(canvasElement));
		await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();

		await userEvent.type(dialog.getByRole("searchbox", { name: "Search time zones" }), "tokyo");
		await userEvent.click(dialog.getByRole("button", { name: /Tokyo/ }));
		await userEvent.click(dialog.getByRole("button", { name: "Save" }));

		await expect(movedTo).toHaveBeenCalledWith("Asia/Tokyo");
		await waitFor(() => expect(args.onOpenChange).toHaveBeenCalledWith(false));
	},
});

/**
 * Browsing a region: its zones by place, with Back to the regions, where the
 * region now names the zone chosen in it.
 */
export const BrowsingRegions = meta.story({
	play: async ({ canvasElement, userEvent }) => {
		const dialog = within(await dialogOf(canvasElement));
		await expect(dialog.getByRole("button", { name: "Australia Sydney" })).toBeInTheDocument();

		await userEvent.click(dialog.getByRole("button", { name: /^Asia/ }));
		await expect(dialog.getByRole("searchbox", { name: "Search Asia" })).toBeInTheDocument();
		await userEvent.click(dialog.getByRole("button", { name: /^Tokyo/ }));
		await userEvent.click(dialog.getByRole("button", { name: "Back" }));

		await expect(dialog.getByRole("button", { name: "Asia Tokyo" })).toBeInTheDocument();
		await expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
	},
});

const MOVES_ROUTINES_NOTE =
	"All routines scheduled on Sydney time will now run in whichever zone you pick.";

/**
 * With routines scheduled on the workspace's time, it says from the start that
 * they move with it, and keeps saying so while another zone is chosen.
 */
export const MovesRoutines = meta.story({
	beforeEach({ msw }) {
		msw.use(...answering(3));
	},
	play: async ({ canvasElement, userEvent }) => {
		const dialog = within(await dialogOf(canvasElement));
		await expect(await dialog.findByText(MOVES_ROUTINES_NOTE)).toBeInTheDocument();

		await userEvent.type(dialog.getByRole("searchbox", { name: "Search time zones" }), "tokyo");
		await userEvent.click(dialog.getByRole("button", { name: /Tokyo/ }));

		await expect(dialog.getByText(MOVES_ROUTINES_NOTE)).toBeInTheDocument();
	},
});

/** A zone the server refuses is said in the dialog, which stays open to choose another. */
export const Refused = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.put(timeZoneUrl, () =>
				HttpResponse.json(
					{ _tag: "BadRequest", message: "That time zone isn't one the server knows" },
					{ status: 400 },
				),
			),
		);
	},
	play: async ({ args, canvasElement, userEvent }) => {
		const dialog = within(await dialogOf(canvasElement));
		await userEvent.type(dialog.getByRole("searchbox", { name: "Search time zones" }), "tokyo");
		await userEvent.click(dialog.getByRole("button", { name: /Tokyo/ }));
		await userEvent.click(dialog.getByRole("button", { name: "Save" }));

		await expect(
			await dialog.findByText("That time zone isn't one the server knows"),
		).toBeInTheDocument();
		await expect(args.onOpenChange).not.toHaveBeenCalled();
	},
});
