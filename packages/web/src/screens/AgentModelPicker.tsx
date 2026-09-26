import { Check } from "lucide-react";
import { useModels } from "@/lib/agents.ts";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * Which model a bot thinks with, from the models the workspace has switched
 * on, grouped by provider, as the design draws every choice of model. Choosing
 * one saves it. Somebody who may not choose sees the same list with the one in
 * use checked, and nothing to press.
 */
export function AgentModelPicker({
	model,
	canChoose,
	onChoose,
}: {
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
			{offered.length > 0 && (
				<p className="-mt-3 m-0 px-1 text-sm text-subtle-foreground">
					Only models that are switched on appear here.
				</p>
			)}
		</>
	);
}
