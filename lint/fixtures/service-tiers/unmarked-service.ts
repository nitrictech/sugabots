import { Context } from "effect";

export class Registry extends Context.Service<Registry, { readonly size: number }>()(
	"fixtures/Registry",
) {}
