import { useRender } from "@base-ui/react/use-render";
import type { Automation, Bot, ListedAutomation } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Plus, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { scheduleLabel } from "@/lib/automation-schedule.ts";
import { useAutomations, useRecentRuns, useWorkspaceAutomations } from "@/lib/automations.ts";
import { useBotTasks } from "@/lib/chats.ts";
import { automationFeedLink, botLink, newAutomationLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { outcomeOf, type RunOutcome, RunStatus } from "@/screens/AutomationRun.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ListTime, PageHeader } from "@/shell/Page.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";

/**
 * A bot's automations down the left, each with how it stands, and the one
 * chosen beside them as `children`: its feed, where its runs post. On a
 * phone the list is the page until one is chosen. With no automations, the
 * page says how one is made.
 */
export function AutomationsPage({
	bot,
	selectedAutomationId,
	making = false,
	children,
}: {
	bot: Bot;
	selectedAutomationId: string | undefined;
	/** Whether an automation is being made beside the list, which on a phone covers it as an open one does. */
	making?: boolean;
	children: ReactNode;
}) {
	const list = useListedAutomations(bot);
	const { workspace } = useWorkspace();
	const full = useWorkspaceAutomations(workspace?.id);
	const automationById = new Map(
		full.data?.items.map((item) => [item.automation.id, item.automation]),
	);
	const automations = list.automations ?? [];
	const title = `${bot.name}'s automations`;
	const chosen = selectedAutomationId !== undefined || making;
	const newAutomation = bot.permissions.manageAutomations && (
		<IconButton
			label="New automation"
			variant="bar"
			// A link, so it says it is the page open rather than pressed.
			aria-current={making ? "page" : undefined}
			render={<Link {...newAutomationLink(bot)} />}
			className={cn(
				"aria-[current=page]:bg-chip aria-[current=page]:text-foreground",
				FLOATING_ON_PHONE,
			)}
		>
			<Plus size={16} strokeWidth={1.75} />
		</IconButton>
	);
	// With none yet, the list stays, with its + where it always is, and the space beside it says how one is made.
	const none = list.automations?.length === 0;
	// A phone has no space beside the list, so the list's own says so.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const noneYet = (
		<div className="flex h-full pb-20">
			<NoAutomations
				title={`No automations for ${bot.name} yet`}
				owner={bot.name}
				create={
					bot.permissions.manageAutomations
						? {
								newAutomation: <Link {...newAutomationLink(bot)} />,
								whoToAsk: (
									<Link {...botLink(bot)} className="focus-ring rounded-sm text-link underline">
										{bot.name}
									</Link>
								),
							}
						: undefined
				}
			/>
		</div>
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<section
				aria-label="Automations"
				className={cn(
					// `min-w-0`: a long bot's name in the title is cut short rather than widening the page.
					"flex min-h-0 min-w-0 flex-col border-border border-r max-md:flex-1 md:w-70 md:shrink-0",
					chosen && "max-md:hidden",
				)}
			>
				<PageHeader title={title} place={{ kind: "bot", bot }} actions={newAutomation} />
				{none && phone && !chosen && <div className="flex min-h-0 flex-1 flex-col">{noneYet}</div>}
				<ul
					className={cn(
						"tab-bar-clearance m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2",
						none && phone && "hidden",
					)}
				>
					{list.isError && (
						<li className="px-2.5 py-2 text-xs text-muted-foreground">
							Automations could not be loaded.
						</li>
					)}
					{none && !phone && (
						// Quiet and in the middle, as Inbox's empty list is; the way to make one is in the space beside it.
						<li className="m-auto px-6 py-16 text-center text-xs text-muted-foreground">
							No automations yet
						</li>
					)}
					{automations.map((row) => (
						<li key={row.automation.id}>
							<AutomationRow
								row={row}
								automation={automationById.get(row.automation.id)}
								selected={row.automation.id === selectedAutomationId}
							/>
						</li>
					))}
				</ul>
			</section>
			<div className={cn("flex min-w-0 flex-1 flex-col", !chosen && "max-md:hidden")}>
				{none && !chosen && !phone ? noneYet : children}
			</div>
		</div>
	);
}

/**
 * A bot's automations as its Automations list shows them, or undefined until
 * they are loaded. Somebody who manages the automations of a bot they do not
 * reach, as an administrator does another person's private bot, reads only
 * how each is set up, so the list says nothing of how they ran.
 */
export function useListedAutomations(bot: Bot): {
	automations: ListedAutomation[] | undefined;
	isError: boolean;
} {
	const reaches = bot.permissions.talk;
	const tasks = useBotTasks(reaches ? bot.id : undefined);
	const definitions = useAutomations(reaches ? undefined : bot.id);
	if (reaches) return { automations: tasks.data?.automations, isError: tasks.isError };
	return {
		automations: definitions.data?.map((automation) => ({
			automation: {
				id: automation.id,
				name: automation.name,
				state: automation.state,
				failed: false,
				pausedAfterFailures: false,
			},
			bot,
			conversation: null,
			mentionsYou: false,
		})),
		isError: definitions.isError,
	};
}

/**
 * No automations yet, and how one is made: for someone who may make one, New
 * automation, with asking the bot instead under it. Anyone else is sent to
 * whoever manages the bot, as a bot makes them only for someone who may.
 */
export function NoAutomations({
	title,
	owner,
	create,
}: {
	title: string;
	/** The bot's name, whose managers make its automations. */
	owner: string;
	/** For a viewer who may manage the bot's automations; omitted for anyone else. */
	create?: {
		/** The element New automation is, such as a link to the form or a button that opens it. */
		newAutomation: useRender.RenderProp;
		/** Who could set one up instead, such as the bot, linked to it. */
		whoToAsk: ReactNode;
	};
}) {
	const newAutomation = useRender({
		enabled: create !== undefined,
		render: create?.newAutomation,
		props: { className: buttonStyles({ size: "sm" }), children: "New automation" },
	});
	return (
		<EmptyState title={title} icon={<RefreshCcw strokeWidth={1.75} />}>
			{create ? (
				<span className="mt-3 flex flex-col items-center gap-3">
					{newAutomation}
					<span>Or ask {create.whoToAsk} to set one up.</span>
				</span>
			) : (
				<>Ask someone who manages {owner} to set one up.</>
			)}
		</EmptyState>
	);
}

/**
 * An automation: the bot that runs it, its name, when it last ran, and under it
 * how it stands: paused, or how its last run went, or when it runs before it
 * has. A paused one is greyer; one whose feed mentions the viewer is bright.
 * It opens the automation's feed, or does what `render` does instead.
 */
export function AutomationRow({
	row,
	automation,
	selected,
	render,
}: {
	row: ListedAutomation;
	/** The automation in full, for when it runs, once the workspace's automations are loaded. */
	automation: Automation | undefined;
	selected: boolean;
	/** The element the row is, such as a button that opens the automation where the list is. */
	render?: useRender.RenderProp;
}) {
	// How it last ran is history, which somebody who manages the bot without reaching it does not read.
	const lastRun = useRecentRuns({
		botId: row.bot.id,
		automationId: row.automation.id,
		enabled: row.bot.permissions.talk,
	}).data?.items[0];
	const paused = row.automation.state === "paused";
	const status: RunOutcome | undefined = paused
		? row.automation.pausedAfterFailures
			? "pausedAfterFailures"
			: "paused"
		: lastRun && outcomeOf(lastRun.state, lastRun.posted);
	const schedule = automation && scheduleLabel(automation);
	return useRender({
		render: render ?? <Link {...automationFeedLink(row.bot, row.automation.id)} />,
		props: {
			"aria-current": selected ? "page" : undefined,
			className: cn(
				"focus-ring flex w-full gap-2.5 rounded-lg p-2.5 text-left transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			),
			children: (
				<>
					<BotAvatar
						color={row.bot.color}
						face={row.bot.face}
						shape={row.bot.shape}
						size={20}
						className={cn("shrink-0", paused && "opacity-50")}
					/>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="flex min-w-0 items-baseline gap-2">
							<span
								className={cn(
									"min-w-0 flex-1 truncate-fade text-xs",
									selected || row.mentionsYou
										? "text-foreground"
										: paused
											? "text-subtle-foreground"
											: "text-muted-foreground",
									row.mentionsYou && "font-semibold",
								)}
							>
								{row.automation.name}
								{row.mentionsYou && <span className="sr-only">, mentions you</span>}
							</span>
							{lastRun && <ListTime at={lastRun.acceptedAt} />}
						</span>
						<span className="flex min-w-0 items-center gap-3 text-xs">
							{status && <RunStatus outcome={status} />}
							{(schedule || !status) && (
								<span className="min-w-0 truncate text-subtle-foreground">
									{schedule ?? "Not run yet"}
								</span>
							)}
						</span>
					</span>
				</>
			),
		},
	});
}
