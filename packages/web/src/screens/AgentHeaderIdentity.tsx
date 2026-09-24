import type { Agent } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentWithPod } from "@/lib/agents.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { SurfaceHeader } from "@/ui/surface.tsx";

type AgentIdentity = Pick<Agent, "id" | "name" | "hue" | "face">;

export function AgentPaneHeader({
	agent,
	section,
	linkToSettings = false,
	titleOnly = false,
	leading,
	context,
	children,
}: {
	agent: AgentIdentity;
	section: string;
	linkToSettings?: boolean;
	titleOnly?: boolean;
	leading?: ReactNode;
	context?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<SurfaceHeader className="flex-wrap gap-y-3 md:flex-nowrap">
			{leading}
			<AgentHeaderIdentity
				agent={agent}
				section={section}
				linkToSettings={linkToSettings}
				titleOnly={titleOnly}
				context={context}
			/>
			{children}
		</SurfaceHeader>
	);
}

export function AgentHeaderIdentity({
	agent,
	section,
	linkToSettings = false,
	titleOnly = false,
	context,
}: {
	agent: AgentIdentity;
	section: string;
	linkToSettings?: boolean;
	titleOnly?: boolean;
	context?: ReactNode;
}) {
	const avatar = <AgentAvatar hue={agent.hue} face={agent.face} size={titleOnly ? 40 : 34} />;
	const placed = useAgentWithPod(agent.id);
	return (
		<div className={`flex min-w-0 flex-1 items-center ${titleOnly ? "gap-4" : "gap-3"}`}>
			{linkToSettings && placed ? (
				<Link
					{...agentSettingsLink(placed)}
					aria-label={`Configure ${agent.name}`}
					className="focus-ring shrink-0 rounded-full"
				>
					{avatar}
				</Link>
			) : (
				avatar
			)}
			{titleOnly ? (
				<h1 className="m-0 min-w-0 truncate font-display text-2xl font-semibold text-heading">
					{agent.name}
				</h1>
			) : (
				<div className="min-w-0">
					<div className="flex min-w-0 items-center gap-2.5">
						<span className="shrink-0 font-semibold text-2xl text-heading">{agent.name}</span>
						<ChevronRight aria-hidden size={16} className="shrink-0 text-subtle-foreground" />
						<h1 className="m-0 truncate font-normal text-muted-foreground text-xl">{section}</h1>
					</div>
					{context !== undefined && (
						<p className="mt-0.5 truncate text-muted-foreground text-xs">{context}</p>
					)}
				</div>
			)}
		</div>
	);
}
