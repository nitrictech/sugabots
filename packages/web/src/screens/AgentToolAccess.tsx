import type { Connection, ConnectionAccess } from "@sugabots/contracts";
import { usableTools } from "@/lib/connections.ts";
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
import { ConnectionToolRow } from "./ConnectionPage.tsx";

/*
 * A connection's tools as a bot meets them. The pod's view lists what a
 * server offers; this says what happens when the bot reaches for each one.
 */

/** The groups in the order someone checking a bot's reach cares about them. */
const GROUPS: { access: Exclude<ConnectionAccess, "off">; heading: string }[] = [
	{ access: "ask", heading: "Asks first" },
	{ access: "allow", heading: "Runs freely" },
];

export function AgentToolsDialog({
	agentName,
	connection,
	presetId,
	open,
	onOpenChange,
}: {
	agentName: string;
	connection: Connection;
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
								const inGroup = usableTools(connection).filter((tool) => tool.access === access);
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
										{inGroup.map((tool) => (
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
