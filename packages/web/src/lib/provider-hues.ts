import type { ProjectColor } from "@sugabots/contracts";

/**
 * The hues a provider's models are drawn in on the usage breakdown, from the
 * project colours so its views read as one family, ordered so neighbours differ.
 */
export const PROVIDER_HUES: readonly ProjectColor[] = [
	"blue",
	"purple",
	"teal",
	"amber",
	"rose",
	"green",
	"orange",
	"plum",
];
