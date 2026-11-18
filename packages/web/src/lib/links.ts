import type { Agent, Connection, Pod } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";
import type { AgentSettingsPage, PodSettingsPage } from "@/lib/workspace-settings.ts";

/*
 * Where a channel or a bot lives in the workspace being looked at.
 *
 * Built from the records rather than from loose params, so no caller assembles
 * an address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate` from a page under `/$workspace`.
 *
 * Pages outside a workspace (onboarding, the OAuth return) name one
 * themselves, and links by fixed key or thread id are written in place.
 */

type ChannelRef = Pick<Pod, "slug">;
type BotRef = Pick<Agent, "handle">;

/** Where a conversation, or a list of files, belongs: a channel, or a bot. */
export type Owner = { pod: ChannelRef } | { agent: BotRef };

/** What is new across the workspace. */
export function activityLink() {
	return linkOptions({ from: "/$workspace", to: "./activity" });
}

/** The person's direct messages with other people. */
export function directMessagesLink() {
	return linkOptions({ from: "/$workspace", to: "./dm" });
}

/** Starting a direct message: choosing whom to, and writing the first message. */
export function newDirectMessageLink() {
	return linkOptions({ from: "/$workspace", to: "./dm/new" });
}

/**
 * One direct message, by its conversation's id, jumped to `message` when one
 * is given. The address names no channel, as a direct message between people
 * is in none.
 */
export function directMessageLink(conversationId: string, search: { message?: string } = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./dm/$conversation",
		params: { conversation: conversationId },
		search,
	});
}

/** Every channel the person could open or join. */
export function channelsLink() {
	return linkOptions({ from: "/$workspace", to: "./channels" });
}

/** Every bot the person reaches. */
export function botsLink() {
	return linkOptions({ from: "/$workspace", to: "./bots" });
}

/** A channel, which opens its main chat. */
export function podLink(pod: ChannelRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel",
		params: { channel: pod.slug },
	});
}

/** A channel's main chat, opened first when nobody has opened it yet. */
export const podChatLink = podLink;

/** A bot, which opens its newest task, or a new one. */
export function botLink(agent: BotRef) {
	return linkOptions({ from: "/$workspace", to: "./bots/$bot", params: { bot: agent.handle } });
}

/** Starting a task with a bot, from its first message. */
export function newTaskLink(agent: BotRef) {
	return linkOptions({ from: "/$workspace", to: "./bots/$bot/new", params: { bot: agent.handle } });
}

function channelFilesLink(pod: ChannelRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel/files",
		params: { channel: pod.slug },
	});
}

function botFilesLink(agent: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/files",
		params: { bot: agent.handle },
	});
}

/** The files of a channel or a bot. */
export function artifactsLink(owner: { pod: ChannelRef }): ReturnType<typeof channelFilesLink>;
export function artifactsLink(owner: { agent: BotRef }): ReturnType<typeof botFilesLink>;
export function artifactsLink(owner: Owner) {
	return "pod" in owner ? channelFilesLink(owner.pod) : botFilesLink(owner.agent);
}

function channelFileLink(pod: ChannelRef, artifactId: string, search: { version?: number }) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel/files/$artifact",
		params: { channel: pod.slug, artifact: artifactId },
		search,
	});
}

function botFileLink(agent: BotRef, artifactId: string, search: { version?: number }) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/files/$artifact",
		params: { bot: agent.handle, artifact: artifactId },
		search,
	});
}

/** One file of a channel or a bot, at `version` when one is given. */
export function artifactLink(
	owner: { pod: ChannelRef },
	artifactId: string,
	search?: { version?: number },
): ReturnType<typeof channelFileLink>;
export function artifactLink(
	owner: { agent: BotRef },
	artifactId: string,
	search?: { version?: number },
): ReturnType<typeof botFileLink>;
export function artifactLink(owner: Owner, artifactId: string, search: { version?: number } = {}) {
	return "pod" in owner
		? channelFileLink(owner.pod, artifactId, search)
		: botFileLink(owner.agent, artifactId, search);
}

export function podSettingsLink(pod: ChannelRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/channels/$channel",
		params: { channel: pod.slug },
	});
}

/** One of a channel's settings pages, General being the channel's own address. */
export function podSettingsPageLink(pod: ChannelRef, page: PodSettingsPage) {
	if (page === "general") return podSettingsLink(pod);
	return linkOptions({
		from: "/$workspace",
		to: "./settings/channels/$channel/$page",
		params: { channel: pod.slug, page },
	});
}

/** A bot's automations, with the first open beside them where there is room. */
export function routinesLink(agent: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations",
		params: { bot: agent.handle },
	});
}

/** An automation being made beside its bot's automations. */
export function newRoutineLink(agent: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations/new",
		params: { bot: agent.handle },
	});
}

/** An automation's own thread, where its runs post, beside its bot's automations; opened first when it has none yet. */
export function routineThreadLink(agent: BotRef, routineId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations/$routine",
		params: { bot: agent.handle, routine: routineId },
	});
}

/** A connection's own page, under its bot's settings. */
export function connectionSettingsLink(agent: BotRef, connection: Pick<Connection, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/bots/$bot/connections/$connection",
		params: { bot: agent.handle, connection: connection.id },
	});
}

/** An automation run or collaboration opened from Inbox as a page of its own. */
export function activityThreadLink(conversationId: string, threadId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./activity/$conversation",
		params: { conversation: conversationId },
		search: { threadPage: threadId },
	});
}

/** What a conversation's address keeps open beside it. */
export interface ConversationLinkSearch {
	thread?: string;
	artifact?: string;
	threads?: ThreadsTab;
}

function channelConversationLink(
	pod: ChannelRef,
	conversationId: string,
	search: ConversationLinkSearch,
) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel/$conversation",
		params: { channel: pod.slug, conversation: conversationId },
		search,
	});
}

function taskLink(agent: BotRef, conversationId: string, search: ConversationLinkSearch) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/tasks/$conversation",
		params: { bot: agent.handle, conversation: conversationId },
		search,
	});
}

/**
 * A conversation where it belongs: a channel's main chat or thread, or a
 * bot's task, with `thread` open beside it, or `artifact` open large. Called
 * with either, it is either; a caller holding one or the other branches.
 */
export function conversationLink(
	place: { pod: ChannelRef; conversationId: string },
	search?: ConversationLinkSearch,
): ReturnType<typeof channelConversationLink>;
export function conversationLink(
	place: { agent: BotRef; conversationId: string },
	search?: ConversationLinkSearch,
): ReturnType<typeof taskLink>;
export function conversationLink(
	place: Owner & { conversationId: string },
	search: ConversationLinkSearch = {},
) {
	return "pod" in place
		? channelConversationLink(place.pod, place.conversationId, search)
		: taskLink(place.agent, place.conversationId, search);
}

export function agentSettingsLink(agent: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/bots/$bot",
		params: { bot: agent.handle },
	});
}

/** One of a bot's settings pages, General being the bot's own address. */
export function agentSettingsPageLink(agent: BotRef, page: AgentSettingsPage) {
	if (page === "general") return agentSettingsLink(agent);
	return linkOptions({
		from: "/$workspace",
		to: "./settings/bots/$bot/$page",
		params: { bot: agent.handle, page },
	});
}

/** A person's page among the workspace's members, by their membership's id. */
export function memberSettingsLink(membership: { id: string }) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/members/$member",
		params: { member: membership.id },
	});
}

/** Which of a bot's tasks are open beside a task: those still going, or those done. */
export type ThreadsTab = "open" | "done";
