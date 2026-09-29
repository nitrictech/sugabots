import type {
	Notification as AppNotification,
	NotificationDelivery,
	NotificationSubject,
} from "@sugabots/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useAgents, usePodAgent } from "@/lib/agents.ts";
import { chatKey } from "@/lib/chats.ts";
import { faceIcon } from "@/lib/face-icon.tsx";
import { agentChatLink } from "@/lib/links.ts";
import { useNotificationPreferences } from "@/lib/notifications.ts";
import { usePods } from "@/lib/pods.ts";
import { useMemberEvents } from "@/lib/thread-events.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { connectionLabel, splitToolKey, stepLabel } from "@/screens/tool-activity.ts";

/** Whether this browser may show notices: the browser's own answer, or `unsupported` without the API. */
export type DesktopPermission = NotificationPermission | "unsupported";

/**
 * Whether `notification` should interrupt the person with a desktop notice:
 * they turned desktop notices on and the browser allows them, it is not a
 * weekend they asked to be left alone on, and they are not already looking at
 * the chat it is about. `showingChatId` is the chat on screen, or undefined
 * when the tab is hidden or shows no chat.
 */
export function shouldInterrupt(
	notification: AppNotification,
	delivery: NotificationDelivery,
	{
		now,
		permission,
		showingChatId,
	}: { now: Date; permission: DesktopPermission; showingChatId: string | undefined },
): boolean {
	if (!delivery.desktop || permission !== "granted") return false;
	if (delivery.quietOnWeekends && isWeekend(now)) return false;
	const { chatId } = notification.subject;
	return chatId === null || chatId !== showingChatId;
}

const SATURDAY = 6;
const SUNDAY = 0;

/** Saturday or Sunday, in the browser's time zone. */
function isWeekend(now: Date): boolean {
	return now.getDay() === SATURDAY || now.getDay() === SUNDAY;
}

/** What the browser says about showing notices, and asking it to allow them. */
export function useDesktopPermission(): {
	permission: DesktopPermission;
	/** Asks the person to allow notices, if the browser has not had an answer from them yet. */
	request: () => Promise<DesktopPermission>;
} {
	const [permission, setPermission] = useState(currentPermission);
	const request = useCallback(async () => {
		if (currentPermission() !== "default") return currentPermission();
		const answer = await window.Notification.requestPermission();
		setPermission(answer);
		return answer;
	}, []);
	return { permission, request };
}

function currentPermission(): DesktopPermission {
	return "Notification" in window ? window.Notification.permission : "unsupported";
}

/**
 * Shows the person's notifications in the open workspace as desktop notices,
 * while a Sugabots tab is open, and opens what one is about when it is clicked.
 */
export function useDesktopNotifications(): void {
	const delivery = useNotificationPreferences().data?.delivery;
	const shownChatId = useShownChatId();
	const openSubject = useOpenSubject();
	const { agents } = useAgents();

	useMemberEvents((notification) => {
		if (!delivery) return;
		const interrupt = shouldInterrupt(notification, delivery, {
			now: new Date(),
			permission: currentPermission(),
			showingChatId: document.visibilityState === "visible" ? shownChatId() : undefined,
		});
		if (!interrupt) return;
		const { title, body } = noticeText(notification.subject);
		const agent = agents?.find((one) => one.id === notification.subject.agentId);
		const icon = agent ? faceIcon(agent).catch(() => APP_ICON) : Promise.resolve(APP_ICON);
		void icon.then((drawn) => {
			// The tag is the notification's, so several open tabs show it once.
			const notice = new window.Notification(title, { body, icon: drawn, tag: notification.id });
			notice.onclick = () => {
				window.focus();
				notice.close();
				openSubject(notification.subject);
			};
		});
	});
}

/**
 * The icon beside a notice's text when the bot it is about cannot be drawn:
 * Sugabots' own. The browser's logo stays on the notice as well, since the
 * system shows it for any page that is not an installed app.
 */
const APP_ICON = "/icon-192.png";

/**
 * A notification's title and text, naming what it is about as the chat does:
 * a tool as its approval card does, `List issues in Linear`.
 */
export function noticeText(subject: NotificationSubject): { title: string; body: string } {
	switch (subject.kind) {
		case "approve": {
			const [first, ...others] = [...new Set(subject.tools)];
			const asked = first ? toolTitle(first) : "Run a tool";
			return {
				title: `${subject.agentName} needs your approval`,
				body: others.length > 0 ? `${asked}, and ${others.length} more` : asked,
			};
		}
	}
}

/** A tool as its approval card titles it: `List issues in Linear`, or a built-in tool's name alone. */
function toolTitle(tool: string): string {
	const { handle, name } = splitToolKey(tool);
	const label = stepLabel(tool, name);
	return handle ? `${label} in ${connectionLabel(handle)}` : label;
}

/** The chat the address shows, read when asked because it is looked up only as a notice arrives. */
function useShownChatId(): () => string | undefined {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const matchRoute = useMatchRoute();
	const params =
		matchRoute({ to: "/$workspace/pods/$pod/agents/$agent" }) ||
		matchRoute({ to: "/$workspace/all/pods/$pod/agents/$agent" });
	const { found } = usePodAgent(params ? params.pod : "", params ? params.agent : "");
	return () => {
		if (!found) return undefined;
		return queries.getQueryData<{ id: string }>(chatKey(workspaceId, found.pod.id, found.agent.id))
			?.id;
	};
}

/** Opens the chat of the bot a notification is about, with its thread beside it when it is in no chat. */
function useOpenSubject(): (subject: NotificationSubject) => void {
	const navigate = useNavigate();
	const { agents } = useAgents();
	const { data: pods } = usePods();
	return (subject) => {
		const agent = agents?.find((one) => one.id === subject.agentId);
		const pod = pods?.find((one) => one.id === subject.podId);
		if (!agent || !pod) return;
		void navigate(
			agentChatLink({ pod, agent }, subject.chatId === null ? { thread: subject.threadId } : {}),
		);
	};
}
