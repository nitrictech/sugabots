import {
	defaultNotificationDelivery,
	type Notification,
	type NotificationDelivery,
} from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { noticeText, shouldInterrupt } from "./desktop-notifications.ts";

const CHAT_ID = "0199a1b2-0000-7000-8000-000000000001";

const approval = (chatId: string | null): Notification => ({
	id: "0199a1b2-0000-7000-8000-000000000002",
	workspaceId: "0199a1b2-0000-7000-8000-000000000003",
	createdAt: "2026-03-03T09:00:00.000Z",
	subject: {
		kind: "approve",
		podId: "0199a1b2-0000-7000-8000-000000000004",
		chatId,
		threadId: "0199a1b2-0000-7000-8000-000000000005",
		agentId: "0199a1b2-0000-7000-8000-000000000006",
		agentName: "Growth Desk",
		tools: ["linear__list_issues"],
	},
});

// Local times, so the weekend is the browser's.
const TUESDAY = new Date(2026, 2, 3, 10);
const SATURDAY = new Date(2026, 2, 7, 10);

const interrupts = (
	delivery: Partial<NotificationDelivery>,
	{
		notification = approval(CHAT_ID),
		now = TUESDAY,
		permission = "granted",
		showingChatId,
	}: Partial<Parameters<typeof shouldInterrupt>[2]> & { notification?: Notification } = {},
) =>
	shouldInterrupt(
		notification,
		{ ...defaultNotificationDelivery, ...delivery },
		{ now, permission, showingChatId },
	);

describe("shouldInterrupt", () => {
	it("interrupts by default in a browser that allows it", () => {
		expect(interrupts({})).toBe(true);
	});

	it("stays quiet for somebody who turned desktop notices off", () => {
		expect(interrupts({ desktop: false })).toBe(false);
	});

	it("stays quiet until the browser allows notices", () => {
		expect(interrupts({}, { permission: "default" })).toBe(false);
		expect(interrupts({}, { permission: "denied" })).toBe(false);
		expect(interrupts({}, { permission: "unsupported" })).toBe(false);
	});

	it("stays quiet on a weekend only for somebody who asked it to", () => {
		expect(interrupts({ quietOnWeekends: true }, { now: SATURDAY })).toBe(false);
		expect(interrupts({ quietOnWeekends: true }, { now: TUESDAY })).toBe(true);
		expect(interrupts({ quietOnWeekends: false }, { now: SATURDAY })).toBe(true);
	});

	it("stays quiet about the chat already on screen", () => {
		expect(interrupts({}, { showingChatId: CHAT_ID })).toBe(false);
		expect(interrupts({}, { showingChatId: "0199a1b2-0000-7000-8000-000000000009" })).toBe(true);
	});

	it("interrupts about a thread in no chat, whatever is on screen", () => {
		expect(interrupts({}, { notification: approval(null), showingChatId: CHAT_ID })).toBe(true);
	});
});

describe("noticeText", () => {
	it("names the tool waiting as its approval card does", () => {
		expect(noticeText(approval(CHAT_ID).subject)).toEqual({
			title: "Growth Desk needs your approval",
			body: "List issues in Linear",
		});
	});

	it("counts the other tools waiting after the first", () => {
		const subject = {
			...approval(CHAT_ID).subject,
			tools: ["linear__create_issue", "linear__close_issue", "linear__create_issue"],
		};
		expect(noticeText(subject).body).toBe("Create issue in Linear, and 1 more");
	});
});
