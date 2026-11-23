/**
 * The chat-reads operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import type { DomainExposure } from "./exposure.ts";

export const chatReadsContracts = {} as const;

export const chatReadsExposure = {} as const satisfies DomainExposure<typeof chatReadsContracts>;
