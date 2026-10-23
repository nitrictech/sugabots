import type { Device, InstalledAgent, LocalAgent } from "@sugabots/contracts";
import { setThisDevice } from "@/lib/devices.ts";

/** Claude Code, found on a computer. */
export const installedClaudeCode: InstalledAgent = {
	kind: "claude-code",
	name: "Claude Code",
	version: "2.1.300",
};

/** Claude Code, lent in the sugabots checkout. */
export const lentInSugabots: LocalAgent = {
	url: "http://0199a3a0-0000-7000-8000-0000000000a1.agents.invalid",
	kind: "claude-code",
	name: "Claude Code in sugabots",
	description: "Claude Code, working in /Users/tim/Code/sugabots on this computer.",
	workingDirectory: "/Users/tim/Code/sugabots",
};

/** Claude Code, lent in the docs checkout. */
export const lentInDocs: LocalAgent = {
	url: "http://0199a3a0-0000-7000-8000-0000000000a2.agents.invalid",
	kind: "claude-code",
	name: "Claude Code in docs",
	description: "Claude Code, working in /Users/tim/Code/docs on this computer.",
	workingDirectory: "/Users/tim/Code/docs",
};

/** A paired computer that is connected, lends two agents, and could lend more. */
export const lendingLaptop: Device = {
	id: "0199a3a0-0000-7000-8000-0000000000d1",
	name: "Tim's MacBook",
	agents: { lent: [lentInSugabots, lentInDocs], installed: [installedClaudeCode] },
	createdAt: "2026-10-22T23:00:00.000Z",
};

/** A paired computer that is connected, has Claude Code, and lends nothing yet. */
export const idleLaptop: Device = {
	id: "0199a3a0-0000-7000-8000-0000000000d3",
	name: "Work laptop",
	agents: { lent: [], installed: [installedClaudeCode] },
	createdAt: "2026-10-21T01:00:00.000Z",
};

/** A paired computer that isn't connected, so lends nothing right now. */
export const offlineDesktop: Device = {
	id: "0199a3a0-0000-7000-8000-0000000000d2",
	name: "Studio desktop",
	agents: null,
	createdAt: "2026-10-20T02:00:00.000Z",
};

/**
 * Runs a story as the desktop app's window on `deviceId`, as the app announces
 * it; returns the cleanup that puts it back to a plain browser. Return it from
 * a story's `beforeEach`.
 */
export function inDesktopApp(deviceId: string) {
	setThisDevice(deviceId);
	return () => setThisDevice(null);
}
