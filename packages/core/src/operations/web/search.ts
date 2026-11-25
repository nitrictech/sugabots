import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { WEB_SEARCH_TOOL, webContracts } from "@sugabots/contracts/operations/web";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanUseWeb } from "../../proofs/can-use-web.ts";
import { named } from "../../proofs/proof.ts";
import { Web } from "../../providers/web/web.ts";
import { defineOperation } from "../operation.ts";

export const search = defineOperation(webContracts["web.search"], (principal, input, call) => {
	if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
		return Effect.fail(new ResourceHidden({ resource: "bot" }));
	}
	return named(principal, principal.workspace, call, (principal, workspace, call) =>
		Effect.gen(function* () {
			const web = yield* Web.Service;
			const canUseWeb = yield* proveCanUseWeb(principal, workspace, WEB_SEARCH_TOOL);
			const approved = yield* proveApproved(principal, call, approvalRule("web.search"), input);
			return yield* web.search(canUseWeb, input, approved);
		}),
	);
});
