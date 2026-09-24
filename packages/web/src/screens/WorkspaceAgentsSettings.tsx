import { Link } from "@tanstack/react-router";
import { ChevronRight, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useAgents, useModels } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { useThreads } from "@/lib/threads.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { Input } from "@/ui/input.tsx";
import { ProviderMark } from "@/ui/provider-mark.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";

/**
 * Every agent in the workspace, across the pods you can see.
 *
 * Crew only. The Scribe and the Facilitator belong to the workspace rather than
 * to a pod, have no last-active of their own and nothing to configure here, so
 * they have their own section instead of a row with three empty cells.
 */
export function WorkspaceAgentsSettings({
	selectedAgentId: _selectedAgentId,
}: {
	selectedAgentId?: string;
}) {
	const { agents, isPending, error } = useAgents();
	const pods = usePods();
	const models = useModels();
	const threads = useThreads();
	const [search, setSearch] = useState("");
	const [podId, setPodId] = useState("all");
	const [modelId, setModelId] = useState("all");
	const needle = useDeferredValue(search.trim().toLowerCase());
	const modelOptions = [
		...new Set((agents ?? []).flatMap((agent) => (agent.model === null ? [] : [agent.model]))),
	].sort();
	const shown = agents?.filter(
		(agent) =>
			(needle === "" || `${agent.name} ${agent.handle}`.toLowerCase().includes(needle)) &&
			(podId === "all" || agent.podId === podId) &&
			(modelId === "all" || agent.model === modelId),
	);
	const podById = new Map(pods.data?.map((pod) => [pod.id, pod]));
	const modelById = new Map(models.data?.models.map((model) => [model.modelId, model]));
	const lastActive = new Map<string, string>();
	for (const thread of threads.data ?? []) {
		const current = lastActive.get(thread.hostAgentId);
		if (!current || thread.updatedAt > current)
			lastActive.set(thread.hostAgentId, thread.updatedAt);
	}

	if (isPending || pods.isPending) return null;
	if (error || pods.error)
		return <Alert className="m-7">{failureMessage(error ?? pods.error)}</Alert>;

	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
			<div className="mx-auto flex w-full max-w-[980px] flex-col gap-4">
				<div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
					<label htmlFor="agent-search" className="relative block w-full sm:max-w-[300px]">
						<span className="sr-only">Search agents</span>
						<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							id="agent-search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search agents"
							className="h-10 pl-9"
						/>
					</label>
					<div className="hidden flex-1 sm:block" />
					<Select value={podId} onValueChange={(value) => setPodId(value ?? "all")}>
						<SelectTrigger className="w-full bg-card sm:w-40" aria-label="Filter by pod">
							<SelectValue>
								{(value: string) =>
									value === "all" ? "All pods" : (podById.get(value)?.name ?? value)
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent align="end">
							<SelectItem value="all">All pods</SelectItem>
							{pods.data?.map((pod) => (
								<SelectItem key={pod.id} value={pod.id}>
									{pod.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={modelId} onValueChange={(value) => setModelId(value ?? "all")}>
						<SelectTrigger className="w-full bg-card sm:w-44" aria-label="Filter by model">
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="end">
							<SelectItem value="all">Any model</SelectItem>
							{modelOptions.map((model) => (
								<SelectItem key={model} value={model}>
									{model}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{shown?.length === 0 ? (
					<EmptyState title="No agents match">Try another search or filter.</EmptyState>
				) : (
					<div className="overflow-x-auto rounded-xl border border-border-subtle">
						<div className="min-w-[720px]">
							<div className="grid grid-cols-[minmax(220px,1fr)_112px_160px_96px_13px] items-center gap-3 border-border-subtle border-b bg-sunken px-4 py-2.5 font-semibold text-subtle-foreground text-xs uppercase tracking-wider">
								<span>Agent</span>
								<span>Pod</span>
								<span>Model</span>
								<span>Last active</span>
								<span />
							</div>
							{shown?.map((agent) => {
								const pod = podById.get(agent.podId);
								if (!pod) return null;
								const model = agent.model === null ? undefined : modelById.get(agent.model);
								return (
									<Link
										key={agent.id}
										{...agentSettingsLink({ pod, agent })}
										className="focus-ring grid grid-cols-[minmax(220px,1fr)_112px_160px_96px_13px] items-center gap-3 border-border-subtle border-b px-4 py-3 last:border-b-0 hover:bg-muted"
									>
										<span className="flex min-w-0 items-center gap-2.5">
											<AgentAvatar hue={agent.hue} face={agent.face} size={26} />
											<span className="min-w-0">
												<span className="block truncate font-medium text-heading text-md">
													{agent.name}
												</span>
												<span className="block truncate font-mono text-subtle-foreground text-xs">
													@{agent.handle}
												</span>
											</span>
										</span>
										<span className="truncate text-foreground text-sm">{pod.name}</span>
										<span className="flex min-w-0 items-center gap-2">
											<ProviderMark preset={model?.providerPreset ?? null} small />
											{agent.model === null ? (
												<span className="truncate text-muted-foreground text-xs">No model</span>
											) : (
												<code className="truncate text-foreground text-xs">{agent.model}</code>
											)}
										</span>
										<span className="text-muted-foreground text-sm">
											{relativeActivity(lastActive.get(agent.id))}
										</span>
										<ChevronRight className="size-3.5 text-subtle-foreground" />
									</Link>
								);
							})}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function relativeActivity(timestamp: string | undefined): string {
	if (!timestamp) return "Never";
	const elapsed = Date.now() - new Date(timestamp).getTime();
	const hours = Math.floor(elapsed / 3_600_000);
	if (hours < 1) return "Just now";
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "Yesterday" : `${days}d ago`;
}
