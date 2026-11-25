import { Context } from "effect";
import { Tier } from "../../../packages/contracts/src/tiers.ts";

export class PerWorkspace extends Context.Service<PerWorkspace, { readonly name: string }>()(
	"fixtures/PerWorkspace",
) {
	declare readonly [Tier]: "workspace";
}
