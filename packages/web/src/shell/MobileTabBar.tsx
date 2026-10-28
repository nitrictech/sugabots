import { useRender } from "@base-ui/react/use-render";
import type { Pod } from "@sugabots/contracts";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Inbox, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAttentionCounts } from "@/lib/chats.ts";
import { podLink } from "@/lib/links.ts";
import { defaultPod, findPod, usePods } from "@/lib/pods.ts";
import { useSession } from "@/lib/session.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** Which of the phone's tabs is open. */
type Tab = "home" | "inbox" | "approvals" | "you";

/**
 * The phone's tabs along its foot, floating over the page: Home, the pods;
 * Inbox, counting what is unread; Approvals, counting what waits on you; and
 * You. Not drawn from the width of a tablet up, where the sidebar holds them.
 */
export function MobileTabBar() {
	const { workspace } = useWorkspace();
	const homePod = useHomePod();
	const typing = useTyping();
	const { unreadInInbox, waitingApprovals } = useAttentionCounts();
	const user = useSession().user;
	const open = useOpenTab();
	// While something is typed, the keyboard and what is typed into have the room.
	if (!workspace || typing) return null;
	const params = { workspace: workspace.slug };
	return (
		<nav
			aria-label="Tabs"
			className="glass mx-4 mt-1 mb-[calc(env(safe-area-inset-bottom)+12px)] grid shrink-0 grid-cols-4 gap-0.5 rounded-[32px] p-[5px] md:hidden"
		>
			<TabLink
				label="Home"
				open={open === "home"}
				render={
					homePod ? <Link {...podLink(homePod)} /> : <Link to="/$workspace" params={params} />
				}
				icon={<HomeIcon />}
			/>
			<TabLink
				label="Inbox"
				open={open === "inbox"}
				render={<Link to="/$workspace/activity" params={params} />}
				icon={<Inbox aria-hidden size={24} strokeWidth={1.75} />}
				count={
					unreadInInbox > 0
						? { value: unreadInInbox, label: `${unreadInInbox} unread`, strong: true }
						: undefined
				}
			/>
			<TabLink
				label="Approvals"
				open={open === "approvals"}
				render={<Link to="/$workspace/approvals" params={params} />}
				icon={<ShieldCheck aria-hidden size={24} strokeWidth={1.75} />}
				count={
					waitingApprovals > 0
						? {
								value: waitingApprovals,
								label: `${waitingApprovals} waiting on you`,
								strong: false,
							}
						: undefined
				}
			/>
			<TabLink
				label="You"
				open={open === "you"}
				render={
					<Link to="/$workspace/settings/$section" params={{ ...params, section: "profile" }} />
				}
				icon={
					<span
						aria-hidden
						className={cn(
							"grid size-6 place-items-center rounded-full bg-chip-strong font-semibold text-[11px] text-foreground",
							open === "you" && "shadow-[0_0_0_1.5px_var(--color-foreground)]",
						)}
					>
						{user?.name.trim().charAt(0).toUpperCase()}
					</span>
				}
			/>
		</nav>
	);
}

/** Whether focus is in something written into, such as the composer, while the keyboard is up. */
function useTyping(): boolean {
	const [typing, setTyping] = useState(false);
	useEffect(() => {
		const check = () => setTyping(isWrittenInto(document.activeElement));
		document.addEventListener("focusin", check);
		document.addEventListener("focusout", check);
		return () => {
			document.removeEventListener("focusin", check);
			document.removeEventListener("focusout", check);
		};
	}, []);
	return typing;
}

function isWrittenInto(element: Element | null): boolean {
	if (!(element instanceof HTMLElement)) return false;
	if (element.isContentEditable || element instanceof HTMLTextAreaElement) return true;
	return (
		element instanceof HTMLInputElement &&
		!["button", "checkbox", "radio", "submit", "range", "color", "file"].includes(element.type)
	);
}

/** The pod Home opens on: the one the address is in, or the one last open. */
function useHomePod(): Pod | undefined {
	const { pod: podSlug } = useParams({ strict: false });
	const { data: pods } = usePods();
	const [lastSlug, setLastSlug] = useState(podSlug);
	if (podSlug !== undefined && podSlug !== lastSlug) setLastSlug(podSlug);
	const slug = podSlug ?? lastSlug;
	return (slug === undefined ? undefined : findPod(pods, slug)) ?? defaultPod(pods);
}

function useOpenTab(): Tab {
	const matchRoute = useMatchRoute();
	if (matchRoute({ to: "/$workspace/activity", fuzzy: true })) return "inbox";
	if (matchRoute({ to: "/$workspace/approvals", fuzzy: true })) return "approvals";
	if (matchRoute({ to: "/$workspace/settings", fuzzy: true })) return "you";
	return "home";
}

function TabLink({
	label,
	open,
	render,
	icon,
	count,
}: {
	label: string;
	open: boolean;
	render: useRender.RenderProp;
	icon: ReactNode;
	/** A count over the icon, light when `strong`. */
	count?: { value: number; label: string; strong: boolean };
}) {
	return useRender({
		render,
		props: {
			"aria-current": open ? "page" : undefined,
			className: cn(
				"focus-ring relative flex h-[50px] flex-col items-center justify-center gap-[3px] rounded-[26px] transition-colors",
				open ? "bg-foreground/8 text-foreground" : "text-subtle-foreground",
			),
			children: (
				<>
					{icon}
					<span className="font-medium text-[10px]">{label}</span>
					{count && (
						<span
							className={cn(
								"absolute top-0.5 left-[calc(50%+6px)] h-[18px] min-w-[18px] rounded-[9px] px-[5px] text-center font-semibold text-[11px] leading-[18px] shadow-[0_0_0_2px_var(--color-chip)]",
								count.strong ? "bg-foreground text-background" : "bg-chip-strong text-foreground",
							)}
						>
							{count.value}
							<span className="sr-only">, {count.label}</span>
						</span>
					)}
				</>
			),
		},
	});
}

function HomeIcon() {
	return (
		<svg
			aria-hidden
			width={24}
			height={24}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />
		</svg>
	);
}
