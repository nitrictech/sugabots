import { Link } from "@tanstack/react-router";
import { Check, Info } from "lucide-react";
import { useModels } from "@/lib/agents.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * Which model a bot thinks with, from the models the workspace has switched
 * on, grouped by provider, as the design draws every choice of model. Choosing
 * one saves it. Somebody who may not choose sees the same list with the one in
 * use checked, and nothing to press. Beneath it, where more models come from.
 */
export function AgentModelPicker({
	agentName,
	model,
	canChoose,
	onChoose,
}: {
	/** Where Back from the Models settings returns to. */
	agentName: string;
	model: string | null;
	canChoose: boolean;
	onChoose: (model: string) => void;
}) {
	const { data, isPending } = useModels();
	const offered = data?.models ?? [];
	const providers = [...new Set(offered.map((candidate) => candidate.providerName))];
	// A model chosen before it was switched off is still the one in use, so it is shown on its own.
	const stranded = model !== null && !offered.some((candidate) => candidate.modelId === model);

	const row = (modelId: string, label: string) => {
		const chosen = modelId === model;
		return (
			<SettingsRow
				key={modelId}
				label={label}
				trailing={
					chosen && <Check aria-hidden size={16} strokeWidth={2.6} className="shrink-0 text-link" />
				}
				onClick={canChoose && !chosen ? () => onChoose(modelId) : undefined}
			/>
		);
	};

	return (
		<>
			{stranded && (
				<SettingsGroup label="In use" note="This model is no longer switched on for the workspace.">
					{row(model, model)}
				</SettingsGroup>
			)}
			{!isPending && offered.length === 0 && (
				<SettingsGroup>
					<SettingsRow label="No models are switched on yet." />
				</SettingsGroup>
			)}
			{providers.map((provider) => (
				<SettingsGroup key={provider} label={provider}>
					{offered
						.filter((candidate) => candidate.providerName === provider)
						.map((candidate) => row(candidate.modelId, candidate.displayName ?? candidate.modelId))}
				</SettingsGroup>
			))}
			{!isPending && <MoreModelsCallout agentName={agentName} />}
		</>
	);
}

/**
 * Only switched-on models are listed, so this says where the rest are: a link
 * to the Models settings for somebody who may manage them, and who to ask for
 * everybody else.
 */
function MoreModelsCallout({ agentName }: { agentName: string }) {
	const may = useWorkspacePermissions();
	const backToAgent = useBackToHere(agentName);
	return (
		<div className="flex items-start gap-3 rounded-panel bg-list px-4 py-3 text-[14px] text-soft-foreground leading-normal">
			<Info aria-hidden size={16} className="mt-0.5 shrink-0 text-subtle-foreground" />
			<p className="m-0">
				Only models switched on for the workspace appear here.{" "}
				{may.manageProviders ? (
					<>
						Add providers and switch on more in{" "}
						<Link
							from="/$workspace"
							to="./settings/$section"
							params={{ section: "providers" }}
							state={backToAgent}
							className="font-medium text-link"
						>
							Models
						</Link>
						.
					</>
				) : (
					"To use another, ask a workspace admin to switch it on."
				)}
			</p>
		</div>
	);
}
