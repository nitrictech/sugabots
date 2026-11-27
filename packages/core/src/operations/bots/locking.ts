import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal } from "../../principal.ts";
import { type HoldsWorkspaceLock, underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { workspaceOfBot } from "../../workspaces/workspace-reference.ts";

/**
 * Runs `body` under the lock of the bot `botId`'s workspace, as every change
 * to who reaches a bot does: the bot, and whoever the change is about, are
 * named afresh inside it. A bot that isn't there is hidden.
 */
export const underBotsLock = <A, E, R>(
	principal: Principal,
	botId: string,
	body: <P, W>(lock: HoldsWorkspaceLock<P, W>) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const workspaceId = yield* workspaceOfBot(botId);
		if (workspaceId === undefined) return yield* new ResourceHidden({ resource: "bot" });
		return yield* underWorkspaceLock(principal, workspaceId, body);
	});
