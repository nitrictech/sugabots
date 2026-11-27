export * as UnsentAttachments from "./unsent-attachments.ts";

import { Duration, Effect, Layer, Schedule } from "effect";
import { processLayer } from "../tiers.ts";
import { ChatFileStore } from "./chat-file-store.ts";

/** How long an attachment may wait for its message to be sent before it is removed. */
const UNSENT_FOR = Duration.hours(24);

/** How often unsent attachments are looked for. */
const INTERVAL = Duration.hours(1);

/**
 * Removes attachments whose message was never sent, such as files added to a draft
 * that was abandoned, every `INTERVAL` for as long as the layer's scope is
 * open, starting at once.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const files = yield* ChatFileStore.Service;
		yield* Effect.forkScoped(
			files.removeUnsentAttachments(UNSENT_FOR).pipe(
				Effect.catchCause((cause) => Effect.logError("Removing unsent attachments failed", cause)),
				Effect.repeat(Schedule.spaced(INTERVAL)),
			),
		);
	}),
).pipe(processLayer, Layer.provide(ChatFileStore.layer));
