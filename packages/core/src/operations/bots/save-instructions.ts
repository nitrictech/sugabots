import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { botsContracts } from "@sugabots/contracts/operations/bots";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanManageBot } from "../../proofs/can-manage-bot.ts";
import { named } from "../../proofs/proof.ts";
import { ServerSettings } from "../../server-settings/server-settings.ts";
import { botSettingsPath } from "../../server-settings/web-app-paths.ts";
import { Bots } from "../../workspaces/bots/bots.ts";
import { workspaceSlugOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

/**
 * A bot saves its own instructions and description, as its asker, who must
 * be able to edit it: only in its own chats, where it is offered this, and
 * once they approve.
 */
export const saveInstructions = defineOperation(
	botsContracts["bots.saveInstructions"],
	(principal, input, call) =>
		Effect.gen(function* () {
			if (principal._tag !== "BotForAsker") return yield* new ResourceHidden({ resource: "bot" });
			const bots = yield* Bots.Service;
			const { webAppUrl } = yield* ServerSettings.Service;
			const saved = yield* named(
				principal,
				principal.bot,
				call,
				input,
				(principal, bot, call, approvedInput) =>
					Effect.gen(function* () {
						const canManage = yield* proveCanManageBot(principal, bot);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("bots.saveInstructions"),
							approvedInput,
							bot,
						);
						return yield* bots.saveInstructions(canManage, approved);
					}),
			);
			const workspaceSlug = yield* workspaceSlugOf(principal.workspace);
			return {
				saved: true as const,
				settingsUrl: `${webAppUrl}${botSettingsPath(workspaceSlug, saved.handle)}`,
			};
		}),
);
