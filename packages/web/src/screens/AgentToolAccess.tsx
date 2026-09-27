import { type Connection, type ConnectionTool, connectionToolMutating } from "@sugabots/contracts";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SettingsGroup } from "@/ui/settings-page.tsx";
import { ConnectionToolRow } from "./ConnectionsSettings.tsx";

/*
 * A connection's tools as a bot meets them. The pod's view lists what a
 * server offers; this says what happens when the bot reaches for each one.
 */

/** What happens when a bot calls a tool: it runs, or it waits for a person to allow it. */
type ToolAccess = "free" | "asks";

export interface AgentTool {
	tool: ConnectionTool;
	access: ToolAccess;
}

/**
 * Each of a connection's tools with what happens when a bot calls it: a tool
 * that changes things always asks first, and so does every tool of a
 * connection set to ask. A connection that is off offers none of them.
 */
export function agentToolsOf(connection: Connection): AgentTool[] {
	if (connection.access === "off") return [];
	return connection.tools.map((tool) => ({
		tool,
		access: connectionToolMutating(tool) || connection.access === "ask" ? "asks" : "free",
	}));
}

/** The groups in the order someone checking a bot's reach cares about them. */
const GROUPS: { access: ToolAccess; heading: string }[] = [
	{ access: "asks", heading: "Asks first" },
	{ access: "free", heading: "Runs freely" },
];

export function AgentToolsDialog({
	agentName,
	connection,
	tools,
	presetId,
	open,
	onOpenChange,
}: {
	agentName: string;
	connection: Connection;
	tools: readonly AgentTool[];
	/** The catalog entry its logo comes from, when it came from one. */
	presetId?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogFormFrame>
				<DialogFormStep
					onSubmit={(event) => {
						event.preventDefault();
						onOpenChange(false);
					}}
				>
					<DialogFormHeader title={`${connection.name} tools`} />
					<DialogFormBody>
						<div className="flex items-center gap-2.5 px-1">
							<ConnectionMark presetId={presetId} name={connection.name} size="sm" />
							<p className="m-0 text-[13.5px] text-muted-foreground">
								What {agentName} can do with them
							</p>
						</div>
						<div className="-mx-1 flex max-h-[min(520px,60vh)] flex-col gap-5 overflow-y-auto px-1">
							{GROUPS.map(({ access, heading }) => {
								const inGroup = tools.filter((entry) => entry.access === access);
								if (inGroup.length === 0) return null;
								return (
									<SettingsGroup
										key={access}
										label={
											<>
												{heading}
												<span aria-hidden className="pl-1.5 font-normal">
													{inGroup.length}
												</span>
											</>
										}
									>
										{inGroup.map(({ tool }) => (
											<ConnectionToolRow key={tool.name} tool={tool} />
										))}
									</SettingsGroup>
								);
							})}
						</div>
					</DialogFormBody>
					<DialogFormFooter action="Done" cancel={false} />
				</DialogFormStep>
			</DialogFormFrame>
		</Dialog>
	);
}
