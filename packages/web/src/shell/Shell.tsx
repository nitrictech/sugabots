import { Outlet } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";
import { useWorkspaceEvents } from "@/lib/thread-events.ts";
import { useVisibleHeight } from "@/lib/visible-height.ts";
import { Rail } from "@/shell/Rail.tsx";

/** The frame: the pod rail, then whatever the address shows beside it. */
export function Shell() {
	useWorkspaceEvents();
	useVisibleHeight();

	return (
		<div className="flex h-[var(--visible-height,100dvh)] min-w-0 overflow-hidden bg-background">
			<Rail />
			<Outlet />
		</div>
	);
}

/** The thread column: everything to the right of the conversation list. */
export function Panes({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<main className={cn("relative flex min-w-0 flex-1 flex-col bg-background", className)}>
			{children}
		</main>
	);
}
