import { Link, useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { SettingsListColumn, SettingsListDetail, SettingsListRow } from "@/ui/settings-page.tsx";
import { AgentSettingsPage } from "./AgentSettingsPage.tsx";

/**
 * Every bot you can see, each under its pod's name, beside the open one's
 * contact card. The + makes a bot in whichever pod you choose.
 */
export function WorkspaceAgentsSettings({
	selectedAgentId,
	selectedAgentTab,
}: {
	selectedAgentId?: string;
	selectedAgentTab?: "routines";
}) {
	const { agents, isPending, error } = useAgents();
	const pods = usePods();
	const navigate = useNavigate();
	const [search, setSearch] = useState("");
	const [creating, setCreating] = useState(false);
	const needle = useDeferredValue(search.trim().toLowerCase());

	if (isPending || pods.isPending) return null;
	if (error || pods.error) {
		return <Alert className="m-7">{failureMessage(error ?? pods.error)}</Alert>;
	}

	const podById = new Map(pods.data?.map((pod) => [pod.id, pod]));
	const crew = (agents ?? []).filter((agent) => agent.systemAgentKey === null);
	const shown = crew.filter((agent) => needle === "" || agent.name.toLowerCase().includes(needle));
	// With none chosen, the first bot is open beside the list; on a phone the list comes first.
	const selected = selectedAgentId
		? crew.find((agent) => agent.id === selectedAgentId)
		: crew.find((agent) => podById.has(agent.podId));
	const selectedPod = selected ? podById.get(selected.podId) : undefined;
	const podsToAddTo = (pods.data ?? []).filter((pod) => pod.permissions.createAgents);

	return (
		<>
			<SettingsListDetail
				detailOpen={selectedAgentId !== undefined}
				back={{
					label: "Bots",
					render: (
						<Link from="/$workspace" to="./settings/$section" params={{ section: "agents" }} />
					),
				}}
				list={
					<SettingsListColumn
						title="Bots"
						newLabel="New bot"
						onNew={podsToAddTo.length > 0 ? () => setCreating(true) : undefined}
						search={search}
						onSearch={setSearch}
					>
						{shown.map((agent) => {
							const pod = podById.get(agent.podId);
							if (!pod) return null;
							return (
								<SettingsListRow
									key={agent.id}
									picture={<AgentAvatar color={agent.color} face={agent.face} size={36} />}
									label={agent.name}
									sub={pod.name}
									selected={agent.id === selected?.id && (selectedAgentId ? true : "wide")}
									render={<Link {...agentSettingsLink({ pod, agent })} />}
								/>
							);
						})}
						{shown.length === 0 && (
							<li className="px-2.5 py-3 text-muted-foreground">
								{needle ? `No bots match “${search.trim()}”.` : "No bots yet."}
							</li>
						)}
					</SettingsListColumn>
				}
				detail={
					selected && selectedPod ? (
						<AgentSettingsPage
							key={selected.id}
							agent={selected}
							pod={selectedPod}
							initialTab={selectedAgentTab}
						/>
					) : (
						<div className="grid min-h-80 place-items-center p-6">
							<EmptyState title={selectedAgentId ? "No such bot here" : "No bots yet"}>
								{selectedAgentId
									? "It may have been deleted, or you may not be in its pod."
									: "Make one with the + above the list."}
							</EmptyState>
						</div>
					)
				}
			/>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewAgentDialog
					pods={podsToAddTo}
					onCreated={async (agent, pod) => {
						setCreating(false);
						if (pod) await navigate(agentSettingsLink({ pod, agent }));
					}}
				/>
			</Dialog>
		</>
	);
}
