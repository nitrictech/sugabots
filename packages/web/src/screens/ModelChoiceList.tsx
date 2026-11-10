import type { WorkspaceModelsResponse } from "@sugabots/contracts";
import { Check } from "lucide-react";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

export type ModelChoice = Pick<
	WorkspaceModelsResponse["models"][number],
	"modelId" | "displayName" | "providerId" | "providerName"
>;

/**
 * Models to choose one of, grouped by provider, with the chosen one checked.
 * Without `onChoose` the list only shows which one is chosen.
 */
export function ModelChoiceList({
	models,
	chosen,
	onChoose,
	empty,
}: {
	models: readonly ModelChoice[];
	chosen: string | null | undefined;
	onChoose?: (modelId: string) => void;
	/** Said when there are no models; nothing is shown without it, as while they load. */
	empty?: string;
}) {
	const providerIds = [...new Set(models.map((model) => model.providerId))];
	if (models.length === 0) {
		return (
			empty && (
				<SettingsGroup>
					<SettingsRow label={empty} />
				</SettingsGroup>
			)
		);
	}
	return providerIds.map((providerId) => {
		const inGroup = models.filter((model) => model.providerId === providerId);
		return (
			<SettingsGroup key={providerId} label={inGroup[0]?.providerName}>
				{inGroup.map((model) => (
					<ModelChoiceRow
						key={model.modelId}
						label={model.displayName ?? model.modelId}
						chosen={model.modelId === chosen}
						onChoose={onChoose && (() => onChoose(model.modelId))}
					/>
				))}
			</SettingsGroup>
		);
	});
}

/** One model in a {@link ModelChoiceList}, pressed while it is the one chosen. */
export function ModelChoiceRow({
	label,
	chosen,
	onChoose,
}: {
	label: string;
	chosen: boolean;
	onChoose?: () => void;
}) {
	return (
		<SettingsRow
			label={label}
			render={onChoose && <button type="button" aria-pressed={chosen} />}
			trailing={
				chosen && <Check aria-hidden size={16} strokeWidth={2.6} className="shrink-0 text-link" />
			}
			onClick={chosen ? undefined : onChoose}
			className={chosen ? "cursor-default" : undefined}
		/>
	);
}
