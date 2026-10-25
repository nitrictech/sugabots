import { expect, fn, userEvent } from "storybook/test";
import preview from "#storybook/preview";
import { UnreachedSitesBanner } from "./DesktopViewer.tsx";

/*
 * The banner across the bottom of a bot's desktop while a person has
 * control, when pages in its browser tried to reach sites the pod's sandbox
 * doesn't allow. The desktop itself needs a live sandbox, so a panel of its
 * size stands in for it.
 */

const meta = preview.meta({
	title: "Product/UnreachedSitesBanner",
	component: UnreachedSitesBanner,
	tags: ["ai-generated"],
	args: {
		agentName: "Some Bot",
		unreached: [
			{ host: "cdn0.woolworths.media", blockedBy: null },
			{ host: "assets.adobedtm.com", blockedBy: null },
			{ host: "ads.tracker.example", blockedBy: "tracker.example" },
		],
		mayAllowSites: true,
		onReview: fn(),
		onHide: fn(),
	},
	decorators: [
		(Story) => (
			<div className="max-w-[720px] bg-background p-5">
				<div className="relative aspect-[16/10] w-full overflow-hidden rounded-panel bg-list">
					<Story />
				</div>
			</div>
		),
	],
});

/** Sites the pod may allow, to review; one the workspace blocks isn't offered. */
export const ToReview = meta.story({
	play: async ({ args, canvas }) => {
		await expect(canvas.getByRole("status")).toHaveTextContent(
			"Pages in Some Bot's browser tried to reach 2 sites that aren't allowed.",
		);
		await userEvent.click(canvas.getByRole("button", { name: "Review sites" }));
		await expect(args.onReview).toHaveBeenCalledWith([
			"cdn0.woolworths.media",
			"assets.adobedtm.com",
		]);
	},
});

/** Someone who may not change the pod's sites is told who can. */
export const NotAnAdmin = meta.story({
	args: { mayAllowSites: false },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status")).toHaveTextContent(
			"An admin of this pod can allow them.",
		);
		await expect(canvas.queryByRole("button", { name: "Review sites" })).toBeNull();
	},
});

/** Only sites the workspace blocks: nothing to allow, said so. */
export const OnlyBlocked = meta.story({
	args: { unreached: [{ host: "ads.tracker.example", blockedBy: "tracker.example" }] },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status")).toHaveTextContent(
			"Pages in Some Bot's browser tried to reach a site the workspace blocks.",
		);
	},
});
