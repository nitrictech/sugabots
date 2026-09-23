import type { SlugTaken } from "@sugabots/core/workspaces/pods/store";
import type { Effect } from "effect";
import { expectTypeOf, it } from "vitest";
import type { RunHandler } from "./handler.ts";

it("requires handlers to map store errors before reaching HTTP", () => {
	expectTypeOf<Effect.Effect<never, SlugTaken>>().not.toExtend<Parameters<RunHandler>[0]>();
});
