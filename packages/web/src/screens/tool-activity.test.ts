import { describe, expect, it } from "vitest";
import { formatDuration, formatTotal } from "./tool-activity.ts";

describe("how tools are worded", () => {
	it("writes a call's time to a tenth, and the reply's total whole", () => {
		expect(formatDuration(473)).toBe("473ms");
		expect(formatDuration(1_400)).toBe("1.4s");
		expect(formatTotal(31_960)).toBe("32s");
		expect(formatTotal(473)).toBe("473ms");
	});
});
