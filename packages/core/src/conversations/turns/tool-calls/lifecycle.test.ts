import { describe, expect, it } from "vitest";
import { UserMessage } from "../../../user-message.ts";
import { DENIED_OUTPUT, ToolCallEvent, type ToolCallState, transition } from "./lifecycle.ts";

/**
 * A tool call's lifecycle on its own: closing a call, deciding its approval,
 * running it once allowed, and what its turn ending does to it.
 */

const sam = "0199a3a0-0000-7000-8000-000000000001";
const alex = "0199a3a0-0000-7000-8000-000000000002";
const turnCancelled = UserMessage.of`Turn cancelled`;

const running: ToolCallState = {
	status: "running",
	approvalStatus: null,
	decidedById: null,
	output: null,
	error: null,
};

const parked: ToolCallState = {
	...running,
	status: "awaiting_approval",
	approvalStatus: "pending",
};

const allowed: ToolCallState = { ...parked, approvalStatus: "allowed", decidedById: sam };

const decide = (decision: "allow_once" | "deny", userId: string) =>
	ToolCallEvent.Decide({ decision: { decision, userId } });

describe("closing a call", () => {
	it("records what the tool returned, or how it failed", () => {
		expect(transition(running, ToolCallEvent.Close({ outcome: { output: { ok: true } } }))).toEqual(
			{
				_tag: "Next",
				state: { ...running, status: "completed", output: { ok: true } },
			},
		);
		const timedOut = UserMessage.of`The tool timed out.`;
		expect(transition(running, ToolCallEvent.Close({ outcome: { error: timedOut } }))).toEqual({
			_tag: "Next",
			state: { ...running, status: "failed", error: timedOut },
		});
	});

	it("leaves a call that is no longer running as it was", () => {
		const failed = { ...running, status: "failed" as const, error: turnCancelled };
		expect(transition(failed, ToolCallEvent.Close({ outcome: { output: "late" } }))._tag).toBe(
			"Refused",
		);
	});
});

describe("deciding an approval", () => {
	it("allows a call, which then waits to run", () => {
		expect(transition(parked, decide("allow_once", sam))).toEqual({
			_tag: "Next",
			state: allowed,
		});
	});

	it("completes a denied call with the denial, for the model to read", () => {
		expect(transition(parked, decide("deny", sam))).toEqual({
			_tag: "Next",
			state: {
				...parked,
				status: "completed",
				approvalStatus: "denied",
				decidedById: sam,
				output: DENIED_OUTPUT,
			},
		});
	});

	it("keeps the first decision", () => {
		expect(transition(allowed, decide("deny", alex))._tag).toBe("Refused");
	});
});

describe("running an approved call", () => {
	it("starts a call once it is allowed, and only once", () => {
		const started = transition(allowed, ToolCallEvent.BeginExecution());
		expect(started).toEqual({ _tag: "Next", state: { ...allowed, status: "running" } });
		if (started._tag !== "Next") return;
		expect(transition(started.state, ToolCallEvent.BeginExecution())._tag).toBe("Refused");
	});

	it("never starts a call nobody allowed", () => {
		expect(transition(parked, ToolCallEvent.BeginExecution())._tag).toBe("Refused");
		const denied = { ...parked, status: "completed" as const, approvalStatus: "denied" as const };
		expect(transition(denied, ToolCallEvent.BeginExecution())._tag).toBe("Refused");
	});
});

describe("a call whose turn ended", () => {
	const abandon = ToolCallEvent.Abandon({ userMessage: turnCancelled });

	it("fails a running call", () => {
		expect(transition(running, abandon)).toEqual({
			_tag: "Next",
			state: { ...running, status: "failed", error: turnCancelled },
		});
	});

	it("denies a pending approval", () => {
		expect(transition(parked, abandon)).toEqual({
			_tag: "Next",
			state: { ...parked, status: "failed", approvalStatus: "denied", error: turnCancelled },
		});
	});

	it("keeps an allowed approval, and leaves finished calls alone", () => {
		expect(transition(allowed, abandon)).toMatchObject({
			state: { status: "failed", approvalStatus: "allowed" },
		});
		const completed = { ...running, status: "completed" as const, output: "done" };
		expect(transition(completed, abandon)._tag).toBe("Refused");
	});
});
