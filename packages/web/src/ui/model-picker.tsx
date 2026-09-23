import type { WorkspaceModelsResponse } from "@sugabots/contracts";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxField,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
} from "@/ui/combobox.tsx";
import { ProviderMark } from "@/ui/provider-mark.tsx";

type WorkspaceModel = WorkspaceModelsResponse["models"][number];

/**
 * Choosing a model, wherever that is done.
 *
 * It filters as you type, because a workspace with two providers connected
 * already offers more models than anybody scrolls, and it shows whose model
 * each one is: the same identifier is served by several providers at different
 * prices, so the provider is part of the choice rather than a detail about it.
 *
 * A value the workspace no longer offers stays at the head of the list. An
 * agent pinned to a model whose provider was disconnected still says what it is
 * on, rather than showing an empty field that implies it has no model at all.
 *
 * The caller owns what the change means — the settings page saves it, the new
 * agent form holds it until the form is submitted.
 */
export function ModelPicker({
	id,
	models,
	value,
	onValueChange,
	disabled = false,
}: {
	id?: string;
	/** What this workspace offers, as the API listed it. */
	models: WorkspaceModel[];
	value: string;
	onValueChange: (modelId: string) => void;
	disabled?: boolean;
}) {
	const modelIds = models.map((model) => model.modelId);
	if (value !== "" && !modelIds.includes(value)) modelIds.unshift(value);
	const about = (modelId: string) => models.find((model) => model.modelId === modelId);
	const chosen = about(value);

	return (
		<Combobox
			items={modelIds}
			value={value}
			disabled={disabled}
			onValueChange={(model) => {
				if (model === null) return;
				onValueChange(model);
			}}
		>
			<ComboboxField>
				<ProviderMark preset={chosen?.providerPreset ?? null} small />
				<ComboboxInput id={id} className="font-mono" placeholder="Choose a model" />
				{chosen && <span className="text-muted-foreground text-sm">{chosen.providerName}</span>}
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
	);
}
