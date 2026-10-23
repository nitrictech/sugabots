import type { LocalAgentKind, ProviderPresetId } from "@sugabots/contracts";
import { cn } from "cn";
import { agentLogos, type ProviderLogoAsset, providerLogos } from "./provider-logos.ts";

interface ProviderLogoProps {
	preset: ProviderPresetId;
	/** Size it here (e.g. `size-5`); the logo keeps its own proportions inside. */
	className?: string;
}

/**
 * A provider's official logo, switching to its dark-background version in
 * dark mode where it has one. Decorative: show the provider's name beside it.
 */
export function ProviderLogo({ preset, className }: ProviderLogoProps) {
	return <Logo logo={providerLogos[preset]} className={className} />;
}

/** The official logo of an agent program a desktop lends. Decorative, like {@link ProviderLogo}. */
export function AgentLogo({ kind, className }: { kind: LocalAgentKind; className?: string }) {
	return <Logo logo={agentLogos[kind]} className={className} />;
}

function Logo({ logo, className }: { logo: ProviderLogoAsset; className?: string | undefined }) {
	const image = cn("shrink-0 object-contain", logo.scale, className);
	if (!logo.dark) return <img src={logo.light} alt="" className={image} />;
	return (
		<>
			<img src={logo.light} alt="" className={cn(image, "dark:hidden")} />
			<img src={logo.dark} alt="" className={cn(image, "hidden dark:block")} />
		</>
	);
}
