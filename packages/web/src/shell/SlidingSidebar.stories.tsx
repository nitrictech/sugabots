import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import preview from "#storybook/preview";
import type { SidebarHiding } from "@/lib/sidebar-hidden.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";
import { SlidingSidebar } from "./SlidingSidebar.tsx";

/*
 * The sidebar beside a chat, put away and brought back with the button in its
 * corner, the chat sliding to fill the room it leaves. A page with no chat or
 * page header on screen has no button.
 */

function Frame({ startHidden, chatShowing }: { startHidden: boolean; chatShowing: boolean }) {
	const [hidden, setHidden] = useState(startHidden);
	const hiding: SidebarHiding = {
		hidden,
		toggle: () => setHidden(!hidden),
		hide: () => setHidden(true),
		chatShowing,
		showingChat: () => () => {},
	};
	return (
		<div className="relative flex h-screen bg-background">
			<SlidingSidebar hiding={hiding}>
				<nav aria-label="Sidebar" className="flex w-64 flex-col gap-px bg-rail px-2 pt-14">
					{["Revenue", "Engineering", "Design"].map((name, index) => (
						<a key={name} href="#chat" className={sidebarRow({ selected: index === 0 })}>
							{name}
						</a>
					))}
				</nav>
			</SlidingSidebar>
			<main className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
				The chat
			</main>
		</div>
	);
}

const meta = preview.meta({
	title: "Product/Sliding Sidebar",
	component: SlidingSidebar,
	parameters: { layout: "fullscreen" },
});

/** Shown beside the chat; the button puts it away. */
export const Shown = meta.story({
	render: () => <Frame startHidden={false} chatShowing />,
	play: async ({ canvas, userEvent }) => {
		await expect(canvas.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Hide sidebar" }));
		await expect(canvas.getByRole("button", { name: "Show sidebar" })).toBeVisible();
	},
});

/** Put away: the chat has the width, and the button brings the sidebar back. */
export const PutAway = meta.story({
	render: () => <Frame startHidden chatShowing />,
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Show sidebar" }));
		await expect(canvas.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
		// It fades in as it slides back.
		await waitFor(() => expect(canvas.getByRole("navigation", { name: "Sidebar" })).toBeVisible());
	},
});

/** NoChatShowing is a page without a chat's header, where the sidebar stays and has no button. */
export const NoChatShowing = meta.story({
	render: () => <Frame startHidden chatShowing={false} />,
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
		await expect(canvas.queryByRole("button", { name: /sidebar/ })).toBeNull();
	},
});
