import { Outlet } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { useAppBadge } from "@/lib/app-badge.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { useNotificationsInThisBrowser } from "@/lib/notifications.ts";
import { useWorkspaceEvents } from "@/lib/thread-events.ts";
import { useVisibleHeight } from "@/lib/visible-height.ts";
import { MobileTabBar } from "@/shell/MobileTabBar.tsx";
import { NotificationsPrompt } from "@/shell/NotificationsPrompt.tsx";
import { Sidebar } from "@/shell/Sidebar.tsx";

/**
 * The frame: the sidebar, then whatever the address shows beside it, under any
 * bar asking for notifications. On a phone, the page alone, over the tabs while
 * it is one of theirs.
 */
export function Shell() {
	useWorkspaceEvents();
	useNotificationsInThisBrowser();
	useVisibleHeight();
	const { unreadMentions, waitingApprovals } = useAttentionCounts();
	useAppBadge(unreadMentions + waitingApprovals);

	// Relative, so `sr-only` text deep in a long list can't lengthen the page.
	return (
		<div className="relative flex h-[var(--visible-height,100dvh)] min-w-0 flex-col overflow-hidden bg-background">
			<NotificationsPrompt />
			<div className="flex min-h-0 min-w-0 flex-1">
				<Sidebar />
				<Outlet />
			</div>
			<MobileTabBar />
		</div>
	);
}

/** The thread column: everything to the right of the sidebar and any list beside it. */
export function Panes({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<main className={cn("relative flex min-w-0 flex-1 flex-col bg-background", className)}>
			{children}
		</main>
	);
}
