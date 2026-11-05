import type { PodColor } from "@sugabots/contracts";

/*
 * Plain data, which the native apps' copies are generated from. apps/codegen
 * loads this module with Node, so it imports nothing but types.
 */

/**
 * The hues a provider's models are drawn in on the usage breakdown, from the
 * pod colours so its views read as one family, ordered so neighbours differ.
 */
export const PROVIDER_HUES: readonly PodColor[] = [
	"blue",
	"purple",
	"teal",
	"amber",
	"rose",
	"green",
	"orange",
	"plum",
];
