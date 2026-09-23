import {
	type Connection,
	type ConnectionTool,
	connectionToolMutating,
	type ToolApprovalRule,
} from "@sugabots/contracts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/ui/dialog.tsx";
import { readableToolName } from "./ConnectionsSettings.tsx";

/*
 * A connection's tools as one agent meets them. The pod's view lists what a
 * server offers; this says what happens when this agent reaches for each one,
 * which depends on three things at once: whether the tool can change
 * anything, whether the connection allows changes, and whether someone has
 * always allowed that tool for this agent.
 */

/** What happens when an agent calls a tool. */
export type ToolAccess = "free" | "asks" | "always" | "unavailable";

export interface AgentTool {
	tool: ConnectionTool;
	access: ToolAccess;
}

/**
 * Each of a connection's tools with what happens when `agentId` calls it: a
 * read runs freely; a change is left out while the connection is read-only,
 * and otherwise asks first unless a standing approval covers it for this agent.
 */
export function agentToolsOf(
	connection: Connection,
	rules: readonly ToolApprovalRule[],
	agentId: string,
): AgentTool[] {
	const alwaysAllowed = new Set(
		rules
			.filter((rule) => rule.agentId === agentId && rule.connectionId === connection.id)
			.map((rule) => rule.toolName),
	);
	return connection.tools.map((tool) => {
		if (!connectionToolMutating(tool)) return { tool, access: "free" };
		if (!connection.allowMutating) return { tool, access: "unavailable" };
		return { tool, access: alwaysAllowed.has(tool.name) ? "always" : "asks" };
	});
}

/** The groups in the order someone checking an agent's reach cares about them. */
const GROUPS: { access: ToolAccess; heading: string }[] = [
	{ access: "asks", heading: "Asks first" },
	{ access: "always", heading: "Always allowed" },
	{ access: "free", heading: "Runs freely" },
	{ access: "unavailable", heading: "Not available" },
];

export function AgentToolsDialog({
	agentName,
	connection,
	tools,
	presetId,
	markHue,
	open,
	onOpenChange,
}: {
	agentName: string;
	connection: Connection;
	tools: readonly AgentTool[];
	/** The catalog entry its logo comes from, when it came from one. */
	presetId?: string;
	markHue: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="grid max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-xl">
				<DialogHeader className="flex-row items-center gap-3">
					<ConnectionMark presetId={presetId} name={connection.name} hue={markHue} size="sm" />
					<div className="flex min-w-0 flex-col gap-1">
						<DialogTitle>{connection.name} tools</DialogTitle>
						<DialogDescription>What {agentName} can do with them</DialogDescription>
					</div>
				</DialogHeader>
				<div className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1">
					{GROUPS.map(({ access, heading }) => {
						const inGroup = tools.filter((entry) => entry.access === access);
						if (inGroup.length === 0) return null;
						return (
							<section key={access} aria-label={heading} className="flex flex-col gap-2">
								<h3 className="m-0 flex items-baseline gap-2 font-semibold text-heading text-sm">
									{heading}
									<span className="font-normal text-muted-foreground text-xs">
										{inGroup.length}
									</span>
								</h3>
								{access === "unavailable" && (
									<p className="m-0 text-muted-foreground text-xs">
										{connection.name} is read only. Allow changes on the connection to let agents
										use these, asking first.
									</p>
								)}
								<ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
									{inGroup.map(({ tool }) => (
										<li key={tool.name} className="flex flex-col gap-0.5 py-2">
											<span
												className={`text-sm ${access === "unavailable" ? "text-muted-foreground" : "text-foreground"}`}
											>
												{readableToolName(tool.name)}
											</span>
											{tool.description && (
												<span className="line-clamp-2 text-muted-foreground text-xs">
													{tool.description}
												</span>
											)}
										</li>
									))}
								</ul>
							</section>
						);
					})}
				</div>
			</DialogContent>
		</Dialog>
	);
}
