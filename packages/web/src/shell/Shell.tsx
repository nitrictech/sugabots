import { Outlet } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { useAppBadge } from "@/lib/app-badge.ts";
import { useAttentionCounts } from "@/lib/chats.ts";
import { useWorkspaceEvents } from "@/lib/thread-events.ts";
import { useVisibleHeight } from "@/lib/visible-height.ts";
import { Sidebar } from "@/shell/Sidebar.tsx";

/** The frame: the sidebar, then whatever the address shows beside it. */
export function Shell() {
	useWorkspaceEvents();
	useVisibleHeight();
	const { unreadMentions, waitingApprovals } = useAttentionCounts();
	useAppBadge(unreadMentions + waitingApprovals);

	// Relative, so `sr-only` text deep in a long list can't lengthen the page.
	return (
		<div className="relative flex h-[var(--visible-height,100dvh)] min-w-0 overflow-hidden bg-background">
			<Sidebar />
			<Outlet />
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
