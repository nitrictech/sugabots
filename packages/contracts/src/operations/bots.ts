/**
 * The bots operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import type { DomainExposure } from "./exposure.ts";

export const botsContracts = {} as const;

export const botsExposure = {} as const satisfies DomainExposure<typeof botsContracts>;
