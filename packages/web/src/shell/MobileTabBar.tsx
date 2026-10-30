import { useRender } from "@base-ui/react/use-render";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { House, Inbox, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useAttentionCounts } from "@/lib/chats.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useSession } from "@/lib/session.ts";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";

/** The phone's four places, along the foot of the screen, in their order there. */
const TABS = ["home", "inbox", "approvals", "you"] as const;

type MobileTab = (typeof TABS)[number];

/**
 * Home, Inbox, Approvals and You, floating along the foot of a phone's
 * screen, the one the page is under marked. Out of the way while the
 * keyboard is up.
 */
export function MobileTabBar({ className }: { className?: string }) {
	const tab = useMobileTab();
	const typing = useTyping();
	const homePod = useHomePodSlug();
	const { unreadInInbox, waitingApprovals } = useAttentionCounts();
	const { user } = useSession();
	if (typing) return null;
	return (
		<nav
			aria-label="Tabs"
			className={cn(
				// Named apart from the page, so it stays still while a page slides past.
				"shrink-0 px-4 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] [view-transition-name:tabs] md:hidden",
				className,
			)}
		>
			<div className="glass relative grid grid-cols-4 gap-0.5 rounded-[32px] p-[5px]">
				{/*
				 * The highlight behind the open tab, one for the bar, so it slides
				 * from tab to tab rather than one going dark as another lights.
				 * A quarter of the bar inside its padding and the three gaps;
				 * each step is its own width and a gap.
				 */}
				<span
					aria-hidden
					className="absolute inset-y-[5px] left-[5px] w-[calc((100%-16px)/4)] rounded-[26px] bg-hover transition-transform duration-300 ease-out motion-reduce:transition-none"
					style={{ transform: `translateX(calc(${TABS.indexOf(tab)} * (100% + 2px)))` }}
				/>
				<TabLink
					render={
						homePod ? (
							<Link from="/$workspace" to="./pods/$pod" params={{ pod: homePod }} />
						) : (
							<Link from="/$workspace" to="./agents" />
						)
					}
					current={tab === "home"}
					icon={<House />}
					label="Home"
				/>
				<TabLink
					render={<Link from="/$workspace" to="./activity" />}
					current={tab === "inbox"}
					icon={<Inbox />}
					label="Inbox"
					count={
						unreadInInbox > 0 && (
							<CountBadge count={unreadInInbox} size="sm" label={`${unreadInInbox} unread`} />
						)
					}
				/>
				<TabLink
					render={<Link from="/$workspace" to="./approvals" />}
					current={tab === "approvals"}
					icon={<ShieldCheck />}
					label="Approvals"
					count={
						waitingApprovals > 0 && (
							<CountBadge
								count={waitingApprovals}
								size="sm"
								label={`${waitingApprovals} waiting on you`}
								className="bg-chip-strong text-foreground"
							/>
						)
					}
				/>
				<TabLink
					render={<Link from="/$workspace" to="./you" />}
					current={tab === "you"}
					icon={
						user ? (
							<PersonAvatar
								person={user}
								size={24}
								className={cn(tab === "you" && "ring-[1.5px] ring-foreground")}
							/>
						) : (
							<span className="size-6 rounded-full bg-person-avatar" />
						)
					}
					label="You"
				/>
			</div>
		</nav>
	);
}

function TabLink({
	render,
	current,
	icon,
	label,
	count,
}: {
	render: useRender.RenderProp;
	current: boolean;
	icon: ReactNode;
	label: string;
	/** A `CountBadge` over the icon's corner. */
	count?: ReactNode;
}) {
	return useRender({
		render,
		props: {
			"aria-current": current ? "page" : undefined,
			className: cn(
				"focus-ring relative flex h-[50px] flex-col items-center justify-center gap-[3px] rounded-[26px] font-medium text-[10px] transition-colors [&>svg]:size-6 [&>svg]:stroke-[1.75]",
				current ? "text-foreground" : "text-muted-foreground",
			),
			children: (
				<>
					{icon}
					{label}
					{count && (
						<span className="absolute top-0.5 left-[calc(50%+6px)] rounded-full ring-2 ring-glass-ring">
							{count}
						</span>
					)}
				</>
			),
		},
	});
}

/**
 * Which tab the page is under: anything in a pod is Home's, a chat opened
 * from Inbox is Inbox's, and settings, reached from You, are You's.
 */
function useMobileTab(): MobileTab {
	const matchRoute = useMatchRoute();
	if (matchRoute({ to: "/$workspace/activity", fuzzy: true })) return "inbox";
	if (matchRoute({ to: "/$workspace/approvals", fuzzy: true })) return "approvals";
	if (
		matchRoute({ to: "/$workspace/you", fuzzy: true }) ||
		matchRoute({ to: "/$workspace/settings", fuzzy: true })
	) {
		return "you";
	}
	return "home";
}

/**
 * Whether the viewer is typing, in a field or the composer, while the
 * keyboard takes the foot of the screen the tabs would have.
 */
function useTyping(): boolean {
	const [typing, setTyping] = useState(false);
	useEffect(() => {
		const update = () => setTyping(isTextEntry(document.activeElement));
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", update);
		return () => {
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", update);
		};
	}, []);
	return typing;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "password", "tel", "number"]);

function isTextEntry(element: Element | null): boolean {
	if (element instanceof HTMLTextAreaElement) return true;
	if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
	return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * The pod Home last showed, so coming back to Home from another tab returns
 * to it; until one is shown, Home opens the workspace's first.
 */
function useHomePodSlug(): string | undefined {
	const { pod } = useParams({ strict: false });
	const { data: pods } = usePods();
	const [last, setLast] = useState<string>();
	if (pod !== undefined && pod !== last) setLast(pod);
	const remembered = pod ?? last;
	return remembered !== undefined && findPod(pods, remembered) ? remembered : undefined;
}
