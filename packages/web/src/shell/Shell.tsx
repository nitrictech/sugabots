import { Dialog } from "@base-ui/react/dialog";
import { Outlet } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Session } from "@/lib/session.ts";
import { useWorkspaceEvents } from "@/lib/thread-events.ts";
import { ThreadPanelProvider } from "@/lib/thread-panel.tsx";
import { AccountMenu } from "@/shell/AccountMenu.tsx";
import { Sidebar } from "@/shell/Sidebar.tsx";
import { TopBar } from "@/shell/TopBar.tsx";
import { DialogOverlay } from "@/ui/dialog.tsx";

export function Shell({ session }: { session: Session }) {
	const [navigationOpen, setNavigationOpen] = useState(false);
	const navigationButton = useRef<HTMLButtonElement>(null);
	useWorkspaceEvents();

	return (
		<ThreadPanelProvider>
			<div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background">
				<TopBar
					navigation={
						<button
							ref={navigationButton}
							type="button"
							aria-label="Open navigation"
							aria-haspopup="dialog"
							aria-expanded={navigationOpen}
							onClick={() => setNavigationOpen(true)}
							className="focus-ring grid size-11 shrink-0 place-items-center rounded-xl bg-card text-muted-foreground md:hidden"
						>
							<Menu size={20} />
						</button>
					}
				/>
				<div className="flex min-h-0 flex-1 gap-gutter px-gutter pb-gutter">
					<div className="hidden min-h-0 w-sidebar shrink-0 flex-col md:flex">
						<Sidebar />
						<AccountMenu session={session} />
					</div>
					<Outlet />
				</div>
			</div>
			{/*
			 * The drawer keeps the screens out of its `Dialog.Root`. Base UI counts
			 * any dialog rendered inside another dialog's tree as nested, open or
			 * not, and a nested dialog drops its backdrop entirely: every dialog a
			 * screen opens would lose its scrim. Opening the drawer from a plain
			 * button rather than `Dialog.Trigger` is what lets the root sit here,
			 * so `finalFocus` has to return focus to that button by hand.
			 */}
			<Dialog.Root open={navigationOpen} onOpenChange={setNavigationOpen}>
				<Dialog.Portal>
					<DialogOverlay className="z-40" />
					<Dialog.Popup
						finalFocus={navigationButton}
						className="fixed inset-y-0 left-0 z-50 flex w-[min(320px,calc(100vw-32px))] flex-col bg-background p-4 shadow-xl"
					>
						<div className="flex shrink-0 items-center justify-between pb-4">
							<Dialog.Title className="font-semibold text-heading text-lg">
								Your workspace
							</Dialog.Title>
							<Dialog.Close
								aria-label="Close navigation"
								className="focus-ring grid size-11 place-items-center rounded-xl text-muted-foreground hover:bg-sidebar-accent"
							>
								<X size={20} />
							</Dialog.Close>
						</div>
						<Sidebar onNavigate={() => setNavigationOpen(false)} />
						<AccountMenu session={session} />
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</ThreadPanelProvider>
	);
}

export function Panes({ children }: { children: React.ReactNode }) {
	return <main className="surface-card relative flex min-w-0 flex-1 flex-col">{children}</main>;
}
