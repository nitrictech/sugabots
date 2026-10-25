import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { useEffect, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { Dialog } from "@/ui/dialog.tsx";
import { AllowUnreachedSitesDialog } from "./AllowUnreachedSitesDialog.tsx";

/*
 * Reviewing the sites the pages in a bot's browser tried to reach, from the
 * banner over its desktop: each named, ticked to start, allowed together and
 * the pages that failed on them loaded again.
 */

const API = import.meta.env.VITE_API_URL;
const sites = ["cdn0.woolworths.media", "assets.adobedtm.com", "s.go-mpulse.net", "dpm.demdex.net"];

/** What the story's API was asked, to check the dialog sent only what was chosen. */
const asked: { allowed: string[][]; reloaded: string[][] } = { allowed: [], reloaded: [] };

function Preview({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
	);
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="min-h-screen bg-background">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/AllowUnreachedSitesDialog",
	component: AllowUnreachedSitesDialog,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		threadId: "0199a3a0-0000-7000-8000-000000000901",
		agentId: "0199a3a0-0000-7000-8000-000000000902",
		agentName: "Some Bot",
		podId: "0199a3a0-0000-7000-8000-000000000903",
		podName: "Super",
		hosts: sites,
		onDone: fn(),
	},
	beforeEach({ msw }) {
		asked.allowed = [];
		asked.reloaded = [];
		msw.use(
			http.post(`${API}/pods/:podId/sandbox/network/hosts`, async ({ request }) => {
				const { hosts } = (await request.json()) as { hosts: string[] };
				asked.allowed.push(hosts);
				return HttpResponse.json({ workspaceHosts: [], addedHosts: [] });
			}),
			http.post(
				`${API}/threads/:threadId/agents/:agentId/desktop/unreached-sites/reload`,
				async ({ request }) => {
					const { hosts } = (await request.json()) as { hosts: string[] };
					asked.reloaded.push(hosts);
					return new HttpResponse(null, { status: 204 });
				},
			),
		);
	},
	decorators: [
		(Story, context) => (
			<Preview key={context.id}>
				<Dialog open>
					<Story />
				</Dialog>
			</Preview>
		),
	],
});

/**
 * Every site named and ticked. Unticking one leaves it out of what's allowed
 * and of the pages loaded again.
 */
export const Review = meta.story({
	play: async ({ args, canvasElement }) => {
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
			name: "Allow sites for Super",
		});
		for (const site of sites) {
			await expect(within(dialog).getByRole("checkbox", { name: site })).toBeChecked();
		}
		await userEvent.click(within(dialog).getByRole("checkbox", { name: "s.go-mpulse.net" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Allow 3 sites" }));

		await waitFor(() => expect(args.onDone).toHaveBeenCalled());
		const chosen = ["cdn0.woolworths.media", "assets.adobedtm.com", "dpm.demdex.net"];
		await expect(asked.allowed).toEqual([chosen]);
		await expect(asked.reloaded).toEqual([chosen]);
	},
});

/** Nothing ticked: nothing to allow. */
export const NoneChosen = meta.story({
	args: { hosts: ["cdn0.woolworths.media"] },
	play: async ({ canvasElement }) => {
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("checkbox", { name: "cdn0.woolworths.media" }));
		await expect(within(dialog).getByRole("button", { name: "Allow 0 sites" })).toBeDisabled();
	},
});

/** A site the workspace blocked since: nothing is allowed, nothing is loaded again, and it says why. */
export const Refused = meta.story({
	beforeEach({ msw }) {
		msw.use(
			http.post(`${API}/pods/:podId/sandbox/network/hosts`, () =>
				HttpResponse.json(
					{
						_tag: "BadRequest",
						message: "assets.adobedtm.com is blocked for this workspace's sandboxes.",
					},
					{ status: 400 },
				),
			),
		);
	},
	play: async ({ args, canvasElement }) => {
		const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Allow 4 sites" }));
		await expect(
			await within(dialog).findByText(/blocked for this workspace's sandboxes/),
		).toBeVisible();
		await expect(asked.reloaded).toEqual([]);
		await expect(args.onDone).not.toHaveBeenCalled();
	},
});
