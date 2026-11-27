import { describe, expect, it } from "vitest";
import { admission, type TurnRequest } from "./requests.ts";

/** How a turn queues in its bot's lane, by who it acts for and why it was asked for. */
describe("turn admission", () => {
	const request = (fields: Partial<TurnRequest>): TurnRequest => ({
		chatId: "chat",
		botId: "bot",
		triggerMessageId: crypto.randomUUID(),
		reason: "mention",
		askerId: "sam",
		...fields,
	});

	it("joins a turn waiting for the same member, and none waiting for another", () => {
		const sams = admission(request({}));
		expect(sams.whenBusy).toBe("coalesce");
		expect(sams.joins(request({ reason: "default" }))).toBe(true);
		expect(sams.joins(request({ askerId: "vee" }))).toBe(false);
	});

	it("queues a helper's turn, a hand-back and a run's turn, which join nothing and nothing joins", () => {
		for (const reason of ["collaboration", "hand_back"] as const) {
			const alone = admission(request({ reason, askerId: undefined }));
			expect(alone.whenBusy).toBe("queue");
			expect(admission(request({})).joins(request({ reason }))).toBe(false);
		}
		const runs = admission(request({ reason: "automation", askerId: null }));
		expect(runs.whenBusy).toBe("queue");
		expect(admission(request({})).joins(request({ reason: "automation", askerId: null }))).toBe(
			false,
		);
	});

	it("joins nothing for a request stored before its asker was", () => {
		const older = request({ askerId: undefined });
		expect(admission(older).whenBusy).toBe("queue");
		expect(admission(request({})).joins(older)).toBe(false);
	});
});
