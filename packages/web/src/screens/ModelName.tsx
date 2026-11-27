import { ProviderLogo } from "@sugabots/provider-logos";
import { useModels } from "@/lib/bots.ts";
import { makerLogoOf, partMaker } from "@/lib/model-makers.ts";
import { modelName } from "@/lib/model-providers.ts";

/**
 * A bot's model as members see it: its maker's logo, where there is one,
 * then its name, without the maker a reseller writes before it, which only
 * a screen reader still hears. Its id until the workspace's models load, or
 * where the workspace no longer offers it.
 */
export function ModelName({ modelId }: { modelId: string }) {
	const model = useModels().data?.models.find((one) => one.modelId === modelId);
	const logo = model && makerLogoOf(model);
	if (!model || !logo) return <>{model ? modelName(model) : modelId}</>;
	const { maker, name } = partMaker(modelName(model));
	return (
		<span className="inline-flex max-w-full min-w-0 items-center gap-1 align-bottom">
			<ProviderLogo builtIn={logo} className="size-3" />
			{maker && <span className="sr-only">{maker}: </span>}
			<span className="truncate">{name}</span>
		</span>
	);
}
