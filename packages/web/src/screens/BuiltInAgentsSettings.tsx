import type { SystemAgent, SystemAgentKey } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
	BUILT_IN_AGENT_KEYS,
	BUILT_IN_AGENT_NAME,
	BUILT_IN_AGENT_UNSET,
	isSetUp,
	useBuiltInAgents,
	useChooseBuiltInAgentModel,
} from "@/lib/built-in-agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { InsetCard } from "@/ui/inset-card.tsx";
import { SettingsRail, SettingsRailItem, SettingsSplitView } from "@/ui/settings-rail.tsx";
import { StatusDot } from "@/ui/status-dot.tsx";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { SystemAgentModelTrial } from "./SystemAgentModelTrial.tsx";

/**
 * The two agents the product ships: the Scribe, which writes summaries, and the
 * Facilitator, which decides who answers in automated threads.
 *
 * They belong to the workspace, not to a pod, so this is the one place they are
 * configured and the one place the screens that depend on them link to. There
 * is nothing to create and nothing to delete — only the model each runs on,
 * which is the whole of setting one up.
 */
export function BuiltInAgentsSettings({ selectedKey }: { selectedKey?: SystemAgentKey }) {
	const { data: agents, isPending, error } = useBuiltInAgents();
	const may = useWorkspacePermissions();
	const navigate = useNavigate();
	const byKey = new Map(agents?.map((agent) => [agent.key, agent]));
	const selected = selectedKey === undefined ? undefined : byKey.get(selectedKey);

	return (
		<SettingsSplitView
			showDetail={selectedKey !== undefined}
			rail={
				<SettingsRail label="Built-in agents">
					{error && <Alert className="mx-2">{failureMessage(error)}</Alert>}
					{BUILT_IN_AGENT_KEYS.map((key) => {
						const agent = byKey.get(key);
						const ready = isSetUp(agent);
						return (
							<SettingsRailItem
								key={key}
								selected={key === selectedKey}
								render={<Link to="/settings/built-in-agents/$key" params={{ key }} />}
							>
								<BuiltInAgentMark agent={agent} />
								<span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
									{agent?.name ?? BUILT_IN_AGENT_NAME[key]}
								</span>
								{!isPending && (
									<StatusDot
										on={ready}
										label={ready ? "Set up" : "Not set up"}
										tooltip={
											ready ? "Set up: it runs on the model chosen" : "Not set up: choose a model"
										}
									/>
								)}
							</SettingsRailItem>
						);
					})}
				</SettingsRail>
			}
			detail={
				selected ? (
					<BuiltInAgentPage
						key={selected.key}
						agent={selected}
						canEdit={may.configureBuiltInAgents}
						onBack={() => {
							void navigate({ to: "/settings/$section", params: { section: "built-in-agents" } });
						}}
					/>
				) : selectedKey !== undefined && !isPending ? (
					<EmptyState title="This workspace has no such agent" />
				) : selectedKey === undefined ? (
					<EmptyState title="The agents that come with the product">
						The Scribe writes a summary of every conversation, and the Facilitator decides who
						answers in automated threads. Choose the model each runs on.
					</EmptyState>
				) : null
			}
		/>
	);
}

/**
 * One built-in agent: what it does, the model it runs on, and a check of that
 * model on the job it actually does.
 *
 * Deliberately free of the router, so every state it has can be seen in a
 * story. Going back is a callback for the same reason.
 */
export function BuiltInAgentPage({
	agent,
	canEdit,
	onBack,
}: {
	agent: SystemAgent;
	canEdit: boolean;
	onBack: () => void;
}) {
	const choose = useChooseBuiltInAgentModel(agent.key);
	const ready = isSetUp(agent);

	return (
		<div
			className="agent-tint w-full max-w-[720px] px-5 py-6 sm:px-8 sm:py-7"
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<header className="flex flex-col gap-4">
				<div className="flex items-start gap-4">
					<IconButton label="Back to built-in agents" className="mt-2 lg:hidden" onClick={onBack}>
						<ArrowLeft />
					</IconButton>
					<AgentAvatar hue={agent.hue} face={agent.face} size={44} />
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<h2 className="m-0 truncate font-display text-2xl font-semibold text-heading">
							{agent.name}
						</h2>
						<p className="m-0 text-md text-muted-foreground">{agent.description}</p>
					</div>
				</div>
			</header>

			{choose.error && <Alert className="mt-4">{failureMessage(choose.error)}</Alert>}

			<div className="mt-7 flex flex-col gap-6">
				{!ready && (
					// The consequence, not just the fact: "not configured" does not tell
					// anybody what they are missing. Not an `Alert`: nothing has gone
					// wrong, and announcing it as a failure would be a lie.
					<InsetCard className="px-4 py-3 text-base text-muted-foreground">
						{BUILT_IN_AGENT_UNSET[agent.key]}{" "}
						{canEdit
							? "Choose one below and it starts on the next reply."
							: "A workspace administrator chooses the model for this agent."}
					</InsetCard>
				)}
				<AgentModelPicker
					model={agent.model}
					canChoose={canEdit}
					onChoose={(model) => {
						choose.mutate(model);
					}}
				/>
				{canEdit && agent.model !== null && (
					<SystemAgentModelTrial model={agent.model} systemAgentKey={agent.key} />
				)}
			</div>
		</div>
	);
}

/**
 * The avatar, once the roster has it. Its space is held meanwhile rather than
 * guessing a colour, so the rail does not change under somebody as it loads.
 */
function BuiltInAgentMark({ agent }: { agent: SystemAgent | undefined }) {
	if (!agent) {
		return <span aria-hidden className="size-7 shrink-0 rounded-lg bg-muted" />;
	}
	return <AgentAvatar hue={agent.hue} face={agent.face} size={28} />;
}
