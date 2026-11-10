import { Link } from "@tanstack/react-router";
import { useModels } from "@/lib/agents.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Note } from "@/ui/note.tsx";
import { SettingsGroup } from "@/ui/settings-page.tsx";
import { ModelChoiceList, ModelChoiceRow } from "./ModelChoiceList.tsx";

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
	// A model chosen before it was switched off is still the one in use, so it is shown on its own.
	const stranded = model !== null && !offered.some((candidate) => candidate.modelId === model);

	return (
		<>
			{stranded && (
				<SettingsGroup label="In use" note="This model is no longer switched on for the workspace.">
					<ModelChoiceRow label={model} chosen />
				</SettingsGroup>
			)}
			<ModelChoiceList
				models={offered}
				chosen={model}
				onChoose={canChoose ? onChoose : undefined}
				empty={isPending ? undefined : "No models are switched on yet."}
			/>
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
		<Note>
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
		</Note>
	);
}
