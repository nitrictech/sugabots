import type { NotificationSettings, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, User } from "lucide-react";
import type { ReactNode } from "react";
import { podSettingsLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import type { useBackToHere } from "@/lib/settings-back.tsx";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { NESTED_INDENT } from "@/shell/ConversationList.tsx";
import { podPalettes } from "@/shell/PodTile.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";

/** A pod the viewer reaches, with how its chats stand for them. */
export interface PodStanding {
	pod: Pod;
	/** How many unread messages its chats hold. */
	unreadMessages: number;
	/** Whether a chat in it waits on the viewer. */
	needsApproval: boolean;
	/** How many of its routines failed their latest run. */
	failedRoutines: number;
}

/**
 * A pod in the sidebar: its name, which folds it away or opens it, and under
 * it, while open, `children`. Under the pointer or on focus, a caret takes
 * the place of the pod's mark and its settings come in at the end. Folded, it
 * says how much is new in it, and is shaded while it holds the page open.
 * Right-clicked, it offers its notifications.
 */
export function SidebarPod({
	standing,
	open,
	holdsSelected,
	onToggle,
	settingsBack,
	notificationSettings,
	children,
}: {
	standing: PodStanding;
	open: boolean;
	/** Whether the page open is in this pod. */
	holdsSelected: boolean;
	onToggle: () => void;
	/** History state for the settings link, so its Back returns to the page it left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	/** What the viewer is notified about, once loaded. */
	notificationSettings?: NotificationSettings;
	children: ReactNode;
}) {
	const { pod } = standing;
	const notificationPlace = { kind: "pod", id: pod.id } as const;
	return (
		// biome-ignore lint/a11y/useSemanticElements: a pod's part of a sidebar holds links, not form controls, so a fieldset is wrong.
		<div role="group" aria-label={pod.name} className="flex flex-col">
			<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
				<div
					className={cn(
						"group/pod flex h-8 items-center rounded-[6px] pr-1.5 transition-colors",
						!open && holdsSelected ? "bg-row-selected" : "hover:bg-row-hover",
					)}
				>
					<button
						type="button"
						aria-expanded={open}
						onClick={onToggle}
						className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-[6px] pl-2 text-left"
					>
						<span className="grid size-5 shrink-0 place-items-center *:col-start-1 *:row-start-1">
							<PodInitial
								pod={pod}
								className="group-hover/pod:invisible group-has-focus-visible/pod:invisible"
							/>
							<ChevronRight
								aria-hidden
								size={14}
								strokeWidth={2.25}
								className={cn(
									"invisible text-muted-foreground transition-transform group-hover/pod:visible group-has-focus-visible/pod:visible",
									open && "rotate-90",
								)}
							/>
						</span>
						<span
							className={cn(
								"min-w-0 flex-1 truncate text-[14px]",
								// Grey like the rows under it; bright when folded over something new.
								!open && hasNews(standing)
									? "font-semibold text-foreground"
									: "font-medium text-muted-foreground group-hover/pod:text-foreground",
							)}
						>
							{pod.name}
						</span>
						<MutedMark settings={notificationSettings} place={notificationPlace} />
					</button>
					{!open && <PodNews standing={standing} />}
					<IconButton
						label={`${pod.name} settings`}
						size="sm"
						render={<Link {...podSettingsLink(pod)} state={settingsBack} />}
						className="hidden group-hover/pod:grid group-has-focus-visible/pod:grid"
					>
						<SettingsIcon />
					</IconButton>
				</div>
			</NotificationsContextMenu>
			{open && <div className={cn("flex flex-col", NESTED_INDENT)}>{children}</div>}
		</div>
	);
}

function hasNews({ unreadMessages, needsApproval, failedRoutines }: PodStanding): boolean {
	return needsApproval || unreadMessages + failedRoutines > 0;
}

/**
 * What is new in a folded pod: a dot while something waits on the viewer's
 * approval. Anything else shows in the pod's bold name, so it is only counted
 * for a screen reader.
 */
function PodNews({ standing }: { standing: PodStanding }) {
	const { unreadMessages, needsApproval, failedRoutines } = standing;
	if (needsApproval) {
		return (
			<span className="mr-2 size-1.5 shrink-0 rounded-full bg-foreground">
				<span className="sr-only">Waiting for your approval</span>
			</span>
		);
	}
	const news = [
		...(unreadMessages > 0 ? [countOf(unreadMessages, "unread message", "unread messages")] : []),
		...(failedRoutines > 0 ? [countOf(failedRoutines, "failed routine", "failed routines")] : []),
	];
	if (news.length === 0) return null;
	return <span className="sr-only">{news.join(", ")}</span>;
}

/** A pod as a small square holding its initial, in the pod's colour, or a person for Personal. */
export function PodInitial({
	pod,
	size = "md",
	className,
}: {
	pod: Pod;
	/** `sm` is a quieter mark for a row that names its pod: the letter in the pod's colour on a tint of it. */
	size?: "md" | "sm";
	className?: string;
}) {
	const palette = pod.color === null ? undefined : podPalettes[pod.color];
	const small = size === "sm";
	return (
		<span
			aria-hidden
			className={cn(
				"grid shrink-0 place-items-center font-semibold",
				small ? "size-4 rounded-[4px] text-[10px]" : "size-5 rounded-[5px] text-[11px]",
				!palette && "bg-tile text-foreground",
				palette && !small && "text-black/80",
				className,
			)}
			style={
				palette &&
				(small
					? { background: palette.tile, color: palette.swatch }
					: { background: palette.swatch })
			}
		>
			{pod.kind === "personal" ? (
				<User size={small ? 10 : 11} strokeWidth={2.25} />
			) : (
				(Array.from(pod.name.trim())[0]?.toUpperCase() ?? "?")
			)}
		</span>
	);
}
