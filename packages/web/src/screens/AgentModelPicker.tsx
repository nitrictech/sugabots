import { useId, useState } from "react";
import { useModels } from "@/lib/agents.ts";
import {
	Combobox,
	ComboboxClear,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxField,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@/ui/combobox.tsx";
import { LabeledField } from "@/ui/labeled-field.tsx";
import { ProviderMark } from "@/ui/provider-mark.tsx";

/**
 * Which model answers. A combobox rather than a plain select: a provider can
 * list dozens of models, so you can type to narrow them. Choosing one saves
 * it; there is nothing to lose half-written. Somebody who may not choose sees
 * the model's name and no list.
 *
 * It takes the model rather than an agent, because a crew agent and a built-in
 * agent are saved through different endpoints and only this part is the same.
 *
 * `null` is an agent with no model: one nobody has set up, or one somebody has
 * cleared. Clearing is the same control for both, because it is the same state
 * — a built-in agent stops running, and a crew agent's turns refuse.
 */
export function AgentModelPicker({
	model,
	canChoose,
	onChoose,
}: {
	model: string | null;
	canChoose: boolean;
	onChoose: (model: string | null) => void;
}) {
	const { data: models } = useModels(canChoose);
	const [draft, setDraft] = useState(model);
	const id = useId();
	const offered = models?.models ?? [];
	const modelIds = offered.map((candidate) => candidate.modelId);
	// A model chosen before it was switched off is still the one in use, so it
	// belongs in the list even when the workspace no longer offers it.
	if (model !== null && !modelIds.includes(model)) modelIds.unshift(model);
	const about = (modelId: string | null) =>
		modelId === null ? undefined : offered.find((candidate) => candidate.modelId === modelId);

	if (!canChoose) {
		return (
			<LabeledField label="Model">
				<div className="flex h-9 items-center gap-2 rounded-lg border border-input bg-raised px-2.5">
					<ProviderMark preset={about(model)?.providerPreset ?? null} small />
					{model === null ? (
						<span className="flex-1 truncate text-base text-muted-foreground">
							No model chosen yet
						</span>
					) : (
						<span className="flex-1 truncate font-mono text-base text-heading">{model}</span>
					)}
				</div>
			</LabeledField>
		);
	}
	return (
		<LabeledField label="Model" htmlFor={id}>
			<Combobox
				items={modelIds}
				value={draft}
				onValueChange={(chosen) => {
					if (chosen === model) return;
					setDraft(chosen);
					onChoose(chosen);
				}}
			>
				<ComboboxField>
					<ProviderMark preset={about(draft)?.providerPreset ?? null} small />
					<ComboboxInput id={id} className="font-mono" placeholder="Choose a model" />
					{about(draft) && (
						<span className="text-sm text-muted-foreground">{about(draft)?.providerName}</span>
					)}
					{draft !== null && <ComboboxClear aria-label="Clear the model" />}
					<ComboboxTrigger aria-label="Choose a model" />
				</ComboboxField>
				<ComboboxContent>
					<ComboboxEmpty>No model matches.</ComboboxEmpty>
					<ComboboxList>
						{(modelId: string) => (
							<ComboboxItem key={modelId} value={modelId}>
								<ProviderMark preset={about(modelId)?.providerPreset ?? null} small />
								<span className="font-mono">{modelId}</span>
							</ComboboxItem>
						)}
					</ComboboxList>
				</ComboboxContent>
			</Combobox>
		</LabeledField>
	);
}
