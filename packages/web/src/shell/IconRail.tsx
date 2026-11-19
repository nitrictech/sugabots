import { useRender } from "@base-ui/react/use-render";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactElement, ReactNode } from "react";
import { botLink, projectLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { attentionOf, type BotStanding } from "@/shell/SidebarBot.tsx";
import { ProjectInitial, type ProjectStanding } from "@/shell/SidebarProject.tsx";
import { AttentionDot } from "@/ui/attention-dot.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * The workspace's sidebar narrowed to icons, down the far left while a bot or
 * a project is open beside it: each project the viewer is in as its tile,
 * then their bots as faces, the Personal Assistant first. Each opens where it
 * leads; the bot or project open is shaded, and a dot marks what is new or
 * waits on the viewer. Their threads are in the sidebar beside it. A phone has
 * no rail. With `toggleRoom`, its top is left clear for the button that puts
 * the sidebar away, which sits over it.
 */
export function IconRail({
	projects,
	bots,
	currentProjectSlug,
	currentBotHandle,
	toggleRoom = false,
}: {
	/** The projects the viewer is in, with how each stands. */
	projects: readonly ProjectStanding[];
	/** The Personal Assistant, then the bots the viewer pinned, with how each stands. */
	bots: readonly BotStanding[];
	currentProjectSlug: string | undefined;
	currentBotHandle: string | undefined;
	toggleRoom?: boolean;
}) {
	return (
		<nav
			aria-label="Projects and bots"
			className="scrollbar-none flex w-14 shrink-0 flex-col items-center gap-3 overflow-y-auto bg-rail pb-3 max-md:hidden"
		>
			{toggleRoom ? <div aria-hidden className="h-10 shrink-0" /> : <div className="h-2" />}
			<ul className="m-0 flex list-none flex-col items-center gap-1 p-0">
				{projects.map((standing) => (
					<li key={standing.project.id}>
						<RailItem
							label={standing.project.name}
							render={<Link {...projectLink(standing.project)} />}
							current={standing.project.slug === currentProjectSlug}
							marker={attentionOf(standing)}
						>
							<ProjectInitial project={standing.project} size="rail" />
						</RailItem>
					</li>
				))}
			</ul>
			<section aria-label="Bots" className="flex flex-col items-center gap-1.5">
				<h2 className="m-0 font-medium text-2xs text-subtle-foreground">Bots</h2>
				<ul className="m-0 flex list-none flex-col items-center gap-1 p-0">
					{bots.map((standing) => (
						<li key={standing.bot.id}>
							<RailItem
								label={standing.bot.name}
								render={<Link {...botLink(standing.bot)} />}
								current={standing.bot.handle === currentBotHandle}
								marker={attentionOf(standing)}
							>
								<BotAvatar
									color={standing.bot.color}
									face={standing.bot.face}
									shape={standing.bot.shape}
									size={22}
								/>
							</RailItem>
						</li>
					))}
				</ul>
			</section>
		</nav>
	);
}

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
				"focus-ring relative grid size-10 place-items-center rounded-lg transition-colors",
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
