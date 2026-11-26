import { Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAppBadge } from "@/lib/app-badge.ts";
import { useWorkspaceEvents } from "@/lib/chat-events.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useNotificationsInThisBrowser } from "@/lib/notifications.ts";
import { useOpenSettings } from "@/lib/open-settings.ts";
import { SidebarHidingProvider, useSidebarHidingState } from "@/lib/sidebar-hidden.tsx";
import { useVisibleHeight } from "@/lib/visible-height.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { SettingsLayout } from "@/screens/SettingsLayout.tsx";
import { MobileTabBar } from "@/shell/MobileTabBar.tsx";
import { NotificationsPrompt } from "@/shell/NotificationsPrompt.tsx";
import { Sidebar } from "@/shell/Sidebar.tsx";
import { SlidingSidebar } from "@/shell/SlidingSidebar.tsx";

const APP_NAME = "Sugabots";

/**
 * The frame: the sidebar, then whatever the address shows beside it, under any
 * bar asking for notifications, and settings over it all while the address
 * has them open. On a phone, the page alone, over the tabs while it is one of
 * theirs, and settings in its place while they are open.
 */
export function Shell() {
	useWorkspaceEvents();
	useNotificationsInThisBrowser();
	useVisibleHeight();
	const sidebarHiding = useSidebarHidingState();
	const { unreadForYou, waitingApprovals } = useAttentionCounts();
	const { workspace } = useWorkspace();
	const settings = useOpenSettings();
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	useAppBadge(
		unreadForYou + waitingApprovals,
		workspace ? `${APP_NAME} | ${workspace.name}` : APP_NAME,
	);

	// From a tablet up, settings are a dialog over the page, which stays as it was beneath
	// them, out of reach until they close. On a phone, they are pages in its place.
	const settingsOverPage = settings !== undefined && !phone;
	// Relative, so `sr-only` text deep in a long list can't lengthen the page.
	return (
		<>
			<div
				inert={settingsOverPage}
				className="relative flex h-visible min-w-0 flex-col overflow-hidden bg-background md:bg-rail"
			>
				<NotificationsPrompt />
				<SidebarHidingProvider value={sidebarHiding}>
					<div className="relative flex min-h-0 min-w-0 flex-1">
						<SlidingSidebar hiding={sidebarHiding}>
							<Sidebar
								// Peeking over a chat, it is only borrowed, so it keeps the width it has.
								resizable={!(sidebarHiding.hidden && sidebarHiding.chatShowing)}
							/>
						</SlidingSidebar>
						<div className="flex min-h-0 min-w-0 flex-1 md:overflow-hidden md:border-border md:border-l md:bg-background">
							{settings && phone ? <SettingsLayout page={settings} /> : <Outlet />}
						</div>
					</div>
				</SidebarHidingProvider>
				<MobileTabBar />
			</div>
			{settingsOverPage && <SettingsLayout page={settings} />}
		</>
	);
}

/** The chat column: everything to the right of the sidebar and any list beside it. */
export function Panes({ children }: { children: ReactNode }) {
	return <main className="relative flex min-w-0 flex-1 flex-col bg-background">{children}</main>;
}
