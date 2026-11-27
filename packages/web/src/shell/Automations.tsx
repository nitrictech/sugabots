import { useRender } from "@base-ui/react/use-render";
import type { Automation, Bot, ListedAutomation } from "@sugabots/contracts";
import { cn } from "cn";
import { Plus, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useAutomations } from "@/lib/automations.ts";
import { useProjectChats } from "@/lib/chats.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import {
	ownerLink,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
	useLeadBot,
} from "@/lib/resource-owner.tsx";
import { automationStartsLabel } from "@/lib/routine-schedule.ts";
import { outcomeOf, type RunOutcome, RunStatus } from "@/screens/AutomationRun.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { OwnerCrumb } from "@/shell/BotCrumb.tsx";
import { ListTime, PageHeader } from "@/shell/Page.tsx";
import { ProblemMark } from "@/ui/attention-dot.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";

/**
 * A bot's or a project's automations as a page, each with how it stands. One
 * chosen, or one being made, takes the page's place as `children`, its
 * breadcrumb the way back. With no automations, the page says how one is made.
 */
export function AutomationsPage({
	owner,
	selectedAutomationId,
	making = false,
	children,
}: {
	owner: ResourceOwner;
	selectedAutomationId: string | undefined;
	/** Whether an automation is being made, which takes the list's place as an open one does. */
	making?: boolean;
	children: ReactNode;
}) {
	const list = useListedAutomations(owner);
	const automations = list.automations ?? [];
	const name = ownerName(owner);
	// "Growth Desk / Automations" from a tablet up; a phone, with no room for the breadcrumb, names the owner.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const title = phone ? `${name}'s automations` : "Automations";
	const chosen = selectedAutomationId !== undefined || making;
	const newAutomation = resourcePermissions(owner).manageAutomations && (
		<IconButton
			label="New automation"
			variant="bar"
			render={ownerLink(owner, { page: "newAutomation" })}
			className={FLOATING_ON_PHONE}
		>
			<Plus size={16} strokeWidth={1.75} />
		</IconButton>
	);
	const none = list.automations?.length === 0;
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<section
				aria-label="Automations"
				className={cn("flex min-h-0 min-w-0 flex-1 flex-col", chosen && "hidden")}
			>
				<PageHeader
					title={title}
					parent={<OwnerCrumb owner={owner} />}
					place={{ kind: "owner", owner }}
					actions={newAutomation}
				/>
				{none ? (
					<NoAutomations
						title={`No automations for ${name} yet`}
						ownerName={name}
						page="fill"
						create={
							resourcePermissions(owner).manageAutomations
								? { newAutomation: ownerLink(owner, { page: "newAutomation" }) }
								: undefined
						}
					/>
				) : (
					<ul className="tab-bar-clearance m-0 flex min-h-0 w-full flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2 md:mx-auto md:max-w-3xl md:pt-4">
						{list.isError && (
							<li className="px-2.5 py-2 text-xs text-muted-foreground">
								Automations could not be loaded.
							</li>
						)}
						{automations.map((row) => (
							<li key={row.automation.id}>
								<AutomationRow row={row} owner={owner} />
							</li>
						))}
					</ul>
				)}
			</section>
			<div className={cn("flex min-w-0 flex-1 flex-col", !chosen && "hidden")}>{children}</div>
		</div>
	);
}

/**
 * One of the automations a list shows, with the bot that runs it, and how it
 * is set up, which says when it runs, once that is loaded.
 */
type ShownAutomation = Omit<ListedAutomation, "status"> & {
	/** Missing for an automation whose runs the member may not read. */
	status?: ListedAutomation["status"];
	bot: Bot;
	definition: Automation | undefined;
};

/**
 * A bot's or a project's automations as its Automations list shows them, or
 * undefined until they are loaded, each with how it stands for whoever may
 * read its runs. A bot's come with its chats; somebody who manages the
 * automations of a bot they do not reach, as an administrator does another
 * member's personal bot, reads them as they are set up, as a project's are,
 * each run by its lead bot.
 */
export function useListedAutomations(owner: ResourceOwner): {
	automations: ShownAutomation[] | undefined;
	isError: boolean;
} {
	const fromChats = "bot" in owner && owner.bot.permissions.talk ? owner.bot : undefined;
	const chats = useProjectChats(fromChats?.defaultProjectId);
	const definitions = useAutomations(resourceProjectId(owner));
	const runner = useLeadBot(owner);
	if (fromChats) {
		const definitionById = new Map(
			definitions.data?.map((automation) => [automation.id, automation]),
		);
		return {
			automations: chats.data?.automations.map((row) => ({
				...row,
				bot: fromChats,
				definition: definitionById.get(row.automation.id),
			})),
			isError: chats.isError,
		};
	}
	return {
		automations:
			runner &&
			definitions.data?.map((automation) => ({
				automation: {
					id: automation.id,
					name: automation.name,
					state: automation.state,
					pausedAfterFailures: automation.pausedAfterFailures,
				},
				bot: runner,
				definition: automation,
				chat: null,
				mentionsYou: false,
				...(automation.status && { status: automation.status }),
			})),
		isError: definitions.isError,
	};
}

/**
 * No automations yet, what one does, and how one is made: for someone who may
 * make one, New automation, with asking the bot instead under it when
 * `whoToAsk` is given. Anyone else is sent to whoever manages the bot or
 * project.
 */
export function NoAutomations({
	title,
	ownerName,
	page,
	create,
}: {
	title: string;
	/** The bot's or project's name, whose managers make its automations. */
	ownerName: string;
	/** As `EmptyState`'s: standing in for a whole page. */
	page?: "min" | "fill";
	/** For a viewer who may manage the bot's automations; omitted for anyone else. */
	create?: {
		/** The element New automation is, such as a link to the form or a button that opens it. */
		newAutomation: useRender.RenderProp;
		/** Who could set one up instead, such as the bot, linked to it. */
		whoToAsk?: ReactNode;
	};
}) {
	const newAutomation = useRender({
		enabled: create !== undefined,
		render: create?.newAutomation,
		props: { className: buttonStyles({ size: "sm" }), children: "New automation" },
	});
	return (
		<EmptyState
			title={title}
			page={page}
			icon={<RefreshCcw strokeWidth={1.75} />}
			actions={
				create && (
					<>
						{newAutomation}
						{create.whoToAsk && <span>Or ask {create.whoToAsk} to set one up.</span>}
					</>
				)
			}
		>
			An automation runs on a timetable, or when a webhook or a GitHub event arrives, and posts what
			it did to its own feed.
			{!create && <> Ask someone who manages {ownerName} to set one up.</>}
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
	owner,
	render,
}: {
	row: ShownAutomation;
	/** The bot or project whose automation it is. */
	owner: ResourceOwner;
	/** The element the row is, such as a button that opens the automation where the list is. */
	render?: useRender.RenderProp;
}) {
	// How it last ran is history, left out for somebody who may not read it.
	const lastRun = row.status?.latestRun ?? undefined;
	const paused = row.automation.state === "paused";
	const status: RunOutcome | undefined = paused
		? row.automation.pausedAfterFailures
			? "pausedAfterFailures"
			: "paused"
		: lastRun && outcomeOf(lastRun.state, lastRun.posted);
	// Said only of one whose runs the viewer may read, which has none.
	const neverRan = !status && row.status?.latestRun === null;
	const when =
		(row.definition && automationStartsLabel(row.definition)) ??
		(neverRan ? "Not run yet" : undefined);
	// Gone wrong: its last run failed, or it paused itself after failing again.
	const problem =
		status === "failed"
			? "Its last run failed"
			: status === "pausedAfterFailures"
				? "Paused after its runs kept failing"
				: undefined;
	const why = problem && lastRun?.state === "failed" ? lastRun.error : null;
	return useRender({
		render: render ?? ownerLink(owner, { page: "automation", automationId: row.automation.id }),
		props: {
			className:
				"focus-ring flex w-full gap-2.5 rounded-lg p-2.5 text-left transition-colors hover:bg-row-hover",
			children: (
				<>
					<BotAvatar
						color={row.bot.color}
						eyes={row.bot.eyes}
						shape={row.bot.shape}
						size={20}
						className={cn("shrink-0", paused && "opacity-50")}
					/>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="flex min-w-0 items-baseline gap-2">
							<span
								className={cn(
									"min-w-0 flex-1 truncate-fade text-xs",
									row.mentionsYou
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
							{problem && (
								<span className="flex shrink-0 self-center">
									<ProblemMark label={problem} />
								</span>
							)}
						</span>
						<span className="flex min-w-0 items-center gap-3 text-xs">
							{status && <RunStatus outcome={status} />}
							{when && <span className="min-w-0 truncate text-subtle-foreground">{when}</span>}
						</span>
						{/* Why, in its own words, so what to do about it is on the list. */}
						{why && <span className="line-clamp-2 text-destructive-text text-xs">{why}</span>}
					</span>
				</>
			),
		},
	});
}
