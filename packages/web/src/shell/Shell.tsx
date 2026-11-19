import { Outlet } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { useAppBadge } from "@/lib/app-badge.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { useWorkspaceEvents } from "@/lib/conversation-events.ts";
import { useNotificationsInThisBrowser } from "@/lib/notifications.ts";
import { SidebarHidingProvider, useSidebarHidingState } from "@/lib/sidebar-hidden.tsx";
import { useVisibleHeight } from "@/lib/visible-height.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { MobileTabBar } from "@/shell/MobileTabBar.tsx";
import { NotificationsPrompt } from "@/shell/NotificationsPrompt.tsx";
import { Sidebar } from "@/shell/Sidebar.tsx";
import { SlidingSidebar } from "@/shell/SlidingSidebar.tsx";

const APP_NAME = "Sugabots";

/**
 * The frame: the sidebar, then whatever the address shows beside it, under any
 * bar asking for notifications. On a phone, the page alone, over the tabs while
 * it is one of theirs.
 */
export function Shell() {
	useWorkspaceEvents();
	useNotificationsInThisBrowser();
	useVisibleHeight();
	const sidebarHiding = useSidebarHidingState();
	const { unreadForYou, waitingApprovals } = useAttentionCounts();
	const { workspace } = useWorkspace();
	useAppBadge(
		unreadForYou + waitingApprovals,
		workspace ? `${APP_NAME} | ${workspace.name}` : APP_NAME,
	);

	// Relative, so `sr-only` text deep in a long list can't lengthen the page.
	return (
		<div className="relative flex h-visible min-w-0 flex-col overflow-hidden bg-background md:bg-rail">
			<NotificationsPrompt />
			<SidebarHidingProvider value={sidebarHiding}>
				<div className="relative flex min-h-0 min-w-0 flex-1">
					<SlidingSidebar hiding={sidebarHiding}>
						<Sidebar
							// Peeking over a conversation, it is only borrowed, so it keeps the width it has.
							resizable={!(sidebarHiding.hidden && sidebarHiding.chatShowing)}
						/>
					</SlidingSidebar>
					<div className="flex min-h-0 min-w-0 flex-1 md:overflow-hidden md:border-border md:border-l md:bg-background">
						<Outlet />
					</div>
				</div>
			</SidebarHidingProvider>
			<MobileTabBar />
		</div>
	);
}

/** The conversation column: everything to the right of the sidebar and any list beside it. */
export function Panes({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<main className={cn("relative flex min-w-0 flex-1 flex-col bg-background", className)}>
			{children}
		</main>
	);
}
