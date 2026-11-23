/**
 * The chats operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import type { DomainExposure } from "./exposure.ts";

export const chatsContracts = {} as const;

export const chatsExposure = {} as const satisfies DomainExposure<typeof chatsContracts>;
