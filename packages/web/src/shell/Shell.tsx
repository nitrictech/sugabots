import { Outlet } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { useAppBadge } from "@/lib/app-badge.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { matchesMedia } from "@/lib/media.ts";
import { useNotificationsInThisBrowser } from "@/lib/notifications.ts";
import { useWorkspaceEvents } from "@/lib/thread-events.ts";
import { useVisibleHeight } from "@/lib/visible-height.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { MobileTabBar } from "@/shell/MobileTabBar.tsx";
import { NotificationsPrompt } from "@/shell/NotificationsPrompt.tsx";
import { Sidebar } from "@/shell/Sidebar.tsx";

/** The manifest's `name`, which an installed window's title must start with. */
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
	const { unreadMentions, waitingApprovals } = useAttentionCounts();
	const { workspace } = useWorkspace();
	const attentionCount = unreadMentions + waitingApprovals;
	useAppBadge(attentionCount);

	// Relative, so `sr-only` text deep in a long list can't lengthen the page.
	return (
		<div className="relative flex h-visible min-w-0 flex-col overflow-hidden bg-background">
			<title>{pageTitle(workspace?.name, attentionCount)}</title>
			<NotificationsPrompt />
			<div className="flex min-h-0 min-w-0 flex-1">
				<Sidebar />
				<Outlet />
			</div>
			<MobileTabBar />
		</div>
	);
}

/** Running as an installed app, in a window of its own. */
const INSTALLED_APP = "(display-mode: standalone)";

/**
 * The app's name, then the workspace's once it has loaded, with a non-zero
 * `attentionCount` in brackets. The count goes first in a tab, where a narrow
 * tab can't cut it off. In an installed window it goes last instead: Chrome
 * and Edge show a title that starts with the app's name as it is, and put the
 * name in front of any other, which would repeat it.
 */
function pageTitle(workspaceName: string | undefined, attentionCount: number): string {
	const title = workspaceName ? `${APP_NAME} | ${workspaceName}` : APP_NAME;
	if (attentionCount === 0) return title;
	return matchesMedia(INSTALLED_APP)
		? `${title} (${attentionCount})`
		: `(${attentionCount}) ${title}`;
}

/** The thread column: everything to the right of the sidebar and any list beside it. */
export function Panes({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<main className={cn("relative flex min-w-0 flex-1 flex-col bg-background", className)}>
			{children}
		</main>
	);
}
