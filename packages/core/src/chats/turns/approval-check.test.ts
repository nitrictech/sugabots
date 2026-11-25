import { Effect } from "effect";
import { expect, it } from "vitest";
import { checkApproval } from "./approval-check.ts";

it("treats returning from an approval check without proving Approved as a defect", async () => {
	await expect(Effect.runPromise(checkApproval(() => Effect.void))).rejects.toThrow(
		"Operation finished an approval check without proving Approved",
	);
});
