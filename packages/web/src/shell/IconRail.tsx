import { useRender } from "@base-ui/react/use-render";
import type { LivelyFace } from "@sugabots/avatars";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { type ReactElement, type ReactNode, useRef } from "react";
import { botLink, projectLink } from "@/lib/links.ts";
import { OWNER_MARK_SIZE_PX, ownerMarkTransition } from "@/lib/owner-mark.ts";
import { TurnTakingAvatar } from "@/shell/Bot.tsx";
import { attentionOf, type BotStanding } from "@/shell/SidebarBot.tsx";
import { ProjectInitial, type ProjectStanding } from "@/shell/SidebarProject.tsx";
import { AttentionDot } from "@/ui/attention-dot.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * The workspace's sidebar narrowed to icons, down the far left while a bot or
 * a project is open beside it: the viewer's Personal Assistant first, then
 * each project they are in as its tile, then their bots as faces. Each opens where it
 * leads; the bot or project open is shaded, and a dot marks what is new or
 * waits on the viewer. Their threads are in the sidebar beside it. A phone has
 * no rail. Its top is left clear for the button that puts the sidebar away,
 * as the sidebar's is.
 */
export function IconRail({
	assistant,
	projects,
	bots,
	currentProjectSlug,
	currentBotHandle,
}: {
	/** The viewer's Personal Assistant, with how it stands, once it is made. */
	assistant: BotStanding | undefined;
	/** The projects the viewer is in, with how each stands. */
	projects: readonly ProjectStanding[];
	/** The bots the viewer pinned, with how each stands. */
	bots: readonly BotStanding[];
	currentProjectSlug: string | undefined;
	currentBotHandle: string | undefined;
}) {
	return (
		// Laid out as the sidebar's sections are, heading and rows alike, and as
		// wide as puts each mark's centre where a row's is (its padding, then
		// half the mark), so a mark moving between them moves only sideways.
		<nav
			aria-label="Projects and bots"
			className="scrollbar-none flex w-15.5 shrink-0 flex-col overflow-y-auto bg-rail pb-3 max-md:hidden"
		>
			<div aria-hidden className="h-10 shrink-0" />
			<div className="flex flex-col items-center pt-1">
				{assistant && (
					<ul className={RAIL_LIST}>
						<li>
							<BotPlace standing={assistant} current={assistant.bot.handle === currentBotHandle} />
						</li>
					</ul>
				)}
				{/* With nothing above it, the sidebar's Projects heading starts its column. */}
				{assistant ? <RailDivider /> : <div aria-hidden className="h-8.25 shrink-0" />}
				<section aria-label="Projects">
					<ul className={RAIL_LIST}>
						{projects.map((standing) => (
							<li key={standing.project.id}>
								<RailItem
									label={standing.project.name}
									render={<Link {...projectLink(standing.project)} />}
									current={standing.project.slug === currentProjectSlug}
									marker={attentionOf(standing)}
								>
									<span style={ownerMarkTransition(standing.project.id)} className="flex">
										<ProjectInitial project={standing.project} size="nav" />
									</span>
								</RailItem>
							</li>
						))}
					</ul>
				</section>
				<RailDivider />
				<section aria-label="Bots">
					<ul className={RAIL_LIST}>
						{bots.map((standing) => (
							<li key={standing.bot.id}>
								<BotPlace standing={standing} current={standing.bot.handle === currentBotHandle} />
							</li>
						))}
					</ul>
				</section>
			</div>
		</nav>
	);
}

/**
 * A bot on the rail, as its face: the same lively face as its sidebar row, so
 * moving between the two draws one face, not two that differ.
 */
function BotPlace({ standing, current }: { standing: BotStanding; current: boolean }) {
	const face = useRef<LivelyFace>(null);
	return (
		<RailItem
			label={standing.bot.name}
			render={<Link {...botLink(standing.bot)} onPointerEnter={() => face.current?.play("hop")} />}
			current={current}
			marker={attentionOf(standing)}
		>
			<span style={ownerMarkTransition(standing.bot.id)} className="flex">
				<TurnTakingAvatar bot={standing.bot} size={OWNER_MARK_SIZE_PX} faceRef={face} />
			</span>
		</RailItem>
	);
}

/**
 * A rule between the rail's groups, centred in the space the sidebar puts
 * between them (the gap between its sections, a section's heading, then the
 * gap above its rows), so the marks on either side line up with its rows.
 */
function RailDivider() {
	return (
		<div aria-hidden className="flex h-12.25 shrink-0 items-center">
			<span className="h-px w-6 bg-border" />
		</div>
	);
}

/** A section's places, spaced as the sidebar's rows are. */
const RAIL_LIST = "m-0 flex list-none flex-col items-center gap-px p-0";

/**
 * One place on the rail: `children` as its mark, named by a tooltip, shaded
 * while it is open, with a dot at its corner for `marker`.
 */
function RailItem({
	label,
	render,
	current,
	marker,
	children,
}: {
	label: string;
	render: ReactElement;
	/** Whether it is the bot or project open. */
	current: boolean;
	marker: ReturnType<typeof attentionOf>;
	children: ReactNode;
}) {
	const link = useRender({
		render,
		props: {
			"aria-current": current ? "page" : undefined,
			className: cn(
				"focus-ring relative grid h-8 w-10 place-items-center rounded-md transition-colors",
				current
					? "bg-row-selected text-foreground"
					: "text-subtle-foreground hover:bg-row-hover hover:text-foreground",
			),
			children: (
				<>
					{children}
					<span className="sr-only">
						{label}
						{marker && `, ${marker.label}`}
					</span>
					{marker && (
						<AttentionDot
							attention={marker.attention}
							className="absolute top-0.5 right-0.5 size-2 ring-2 ring-rail"
						/>
					)}
				</>
			),
		},
	});
	return (
		<Tooltip label={label} side="right">
			{link}
		</Tooltip>
	);
}
