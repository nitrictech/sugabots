import type { LivelyFace } from "@sugabots/avatars";
import type { Bot, NotificationSettings } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useRef } from "react";
import { useModels } from "@/lib/bots.ts";
import { botLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { ownerProblems } from "@/lib/owner-pages.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { TurnTakingAvatar } from "@/shell/Bot.tsx";
import { type Attention, AttentionDot, ProblemMark } from "@/ui/attention-dot.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";

/** How a bot stands for the viewer, as the sidebar marks it. */
export interface BotStanding {
	bot: Bot;
	/** How many unread messages its threads and automations' feeds hold. */
	unreadMessages: number;
	/** Whether one of its conversations waits on the viewer. */
	needsApproval: boolean;
	/** How many of its automations failed their latest run. */
	failedAutomations: number;
}

/** How a bot stands while the sidebar's markers have nothing for it, or have not loaded. */
export const NOTHING_NEW = { unreadMessages: 0, needsApproval: false, failedAutomations: 0 };

/**
 * A bot on one line, which opens its page, where a thread with it starts. At its
 * end, what is new in it, and beside that an alert while something is wrong
 * that its settings or automations set right. Right-clicked, it offers its
 * notifications.
 */
export function SidebarBot({
	standing,
	selected,
	notificationSettings,
}: {
	standing: BotStanding;
	/** Whether the bot's page is the one open. */
	selected: boolean;
	notificationSettings?: NotificationSettings;
}) {
	const { bot, unreadMessages, needsApproval, failedAutomations } = standing;
	const face = useRef<LivelyFace>(null);
	const hideSidebar = useHideSidebar();
	const enabledModels = useModels().data?.models;
	const problems = ownerProblems(
		{ bot },
		{ lead: bot, enabledModels, automationFailed: failedAutomations > 0 },
	);
	const problem = problems.settings ?? problems.automations;
	const attention = unreadMessages > 0 || needsApproval;
	const notificationPlace = { kind: "bot", id: bot.id } as const;
	return (
		<li className="flex flex-col">
			<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
				<Link
					{...botLink(bot)}
					aria-current={selected ? "page" : undefined}
					onDoubleClick={hideSidebar}
					onPointerEnter={() => face.current?.play("hop")}
					className={cn(sidebarRow({ selected, phone: true }), attention && "text-foreground")}
				>
					<TurnTakingAvatar bot={bot} size={18} faceRef={face} className="shrink-0" />
					<span className={cn("min-w-0 flex-1 truncate-fade", attention && "font-semibold")}>
						{bot.name}
					</span>
					<MutedMark settings={notificationSettings} place={notificationPlace} />
					{(attention || problem) && (
						<span className={cn(END_SLOT, problem && attention && "w-auto gap-1.5")}>
							{/* Read after its name, as a row reads what waits in it. */}
							<span className="sr-only">, </span>
							<RowAttention unreadMessages={unreadMessages} needsApproval={needsApproval} />
							{problem && <ProblemMark label={problem} />}
						</span>
					)}
				</Link>
			</NotificationsContextMenu>
		</li>
	);
}

/**
 * The end of a sidebar row, as wide as the + beside a section's name, so a
 * row's dot, its +, and the section's + all line up.
 */
export const END_SLOT = "grid w-5.5 shrink-0 place-items-center";

/** What waits on the viewer in a bot or project. */
interface Waiting {
	unreadMessages: number;
	needsApproval: boolean;
}

/**
 * What a bot's or project's dot says, if anything: it needs the viewer, as a
 * decision or a mention does, or it holds unread messages, with how many.
 */
export function attentionOf({
	unreadMessages,
	needsApproval,
}: Waiting): { attention: Attention; label: string } | undefined {
	const unread =
		unreadMessages > 0 ? countOf(unreadMessages, "unread message", "unread messages") : undefined;
	if (needsApproval) {
		return { attention: "needsYou", label: unread ? `${unread}, needs you` : "Needs you" };
	}
	return unread ? { attention: "unread", label: unread } : undefined;
}

/**
 * At a row's end: a dot while it waits on the viewer. Unread messages show in
 * the row's bold name, so they are only counted for a screen reader.
 */
export function RowAttention({ className, ...waiting }: Waiting & { className?: string }) {
	const marker = attentionOf(waiting);
	if (!marker) return null;
	if (marker.attention === "unread") return <span className="sr-only">{marker.label}</span>;
	return <AttentionDot attention="needsYou" label={marker.label} className={className} />;
}
