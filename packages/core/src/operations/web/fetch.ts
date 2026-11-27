import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { WEB_FETCH_TOOL, webContracts } from "@sugabots/contracts/operations/web";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanUseWeb } from "../../proofs/can-use-web.ts";
import { named } from "../../proofs/proof.ts";
import { Web } from "../../providers/web/web.ts";
import { defineOperation } from "../operation.ts";

export const fetch = defineOperation(webContracts["web.fetch"], (principal, input, call) => {
	if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
		return Effect.fail(new ResourceHidden({ resource: "bot" }));
	}
	return named(
		principal,
		principal.workspace,
		call,
		input,
		(principal, workspace, call, approvedInput) =>
			Effect.gen(function* () {
				const web = yield* Web.Service;
				const canUseWeb = yield* proveCanUseWeb(principal, workspace, WEB_FETCH_TOOL);
				const approved = yield* proveApproved(
					principal,
					call,
					approvalRule("web.fetch"),
					approvedInput,
					workspace,
				);
				return yield* web.fetch(canUseWeb, approved);
			}),
	);
});
