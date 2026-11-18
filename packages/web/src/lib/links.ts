import type { Bot, Channel, Connection } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";
import type { BotSettingsPage, ChannelSettingsPage } from "@/lib/workspace-settings.ts";

/*
 * Where a channel or a bot lives in the workspace being looked at.
 *
 * Built from the records rather than from loose params, so no caller assembles
 * an address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate` from a page under `/$workspace`.
 *
 * Pages outside a workspace (onboarding, the OAuth return) name one
 * themselves, and links by fixed key or conversation id are written in place.
 */

type ChannelRef = Pick<Channel, "slug">;
type BotRef = Pick<Bot, "handle">;

/** Where a conversation, or a list of files, belongs: a channel, or a bot. */
export type Owner = { channel: ChannelRef } | { bot: BotRef };

/** What is new across the workspace. */
export function inboxLink() {
	return linkOptions({ from: "/$workspace", to: "./inbox" });
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
export function channelLink(channel: ChannelRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel",
		params: { channel: channel.slug },
	});
}

/** A bot's own page, where a task with it starts. */
export function botLink(bot: BotRef) {
	return linkOptions({ from: "/$workspace", to: "./bots/$bot", params: { bot: bot.handle } });
}

/** Starting a task with a bot, from its first message. */
export function newTaskLink(bot: BotRef) {
	return linkOptions({ from: "/$workspace", to: "./bots/$bot/new", params: { bot: bot.handle } });
}

function channelFilesLink(channel: ChannelRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel/files",
		params: { channel: channel.slug },
	});
}

function botFilesLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/files",
		params: { bot: bot.handle },
	});
}

/** The files of a channel or a bot. */
export function filesLink(owner: { channel: ChannelRef }): ReturnType<typeof channelFilesLink>;
export function filesLink(owner: { bot: BotRef }): ReturnType<typeof botFilesLink>;
export function filesLink(owner: Owner) {
	return "channel" in owner ? channelFilesLink(owner.channel) : botFilesLink(owner.bot);
}

function channelFileLink(channel: ChannelRef, fileId: string, search: { version?: number }) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel/files/$file",
		params: { channel: channel.slug, file: fileId },
		search,
	});
}

function botFileLink(bot: BotRef, fileId: string, search: { version?: number }) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/files/$file",
		params: { bot: bot.handle, file: fileId },
		search,
	});
}

/** One file of a channel or a bot, at `version` when one is given. */
export function fileLink(
	owner: { channel: ChannelRef },
	fileId: string,
	search?: { version?: number },
): ReturnType<typeof channelFileLink>;
export function fileLink(
	owner: { bot: BotRef },
	fileId: string,
	search?: { version?: number },
): ReturnType<typeof botFileLink>;
export function fileLink(owner: Owner, fileId: string, search: { version?: number } = {}) {
	return "channel" in owner
		? channelFileLink(owner.channel, fileId, search)
		: botFileLink(owner.bot, fileId, search);
}

export function channelSettingsLink(channel: ChannelRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/channels/$channel",
		params: { channel: channel.slug },
	});
}

/** One of a channel's settings pages, General being the channel's own address. */
export function channelSettingsPageLink(channel: ChannelRef, page: ChannelSettingsPage) {
	if (page === "general") return channelSettingsLink(channel);
	return linkOptions({
		from: "/$workspace",
		to: "./settings/channels/$channel/$page",
		params: { channel: channel.slug, page },
	});
}

/** A bot's automations, listed as a page of their own. */
export function automationsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations",
		params: { bot: bot.handle },
	});
}

/** An automation being made, as a page under its bot's automations. */
export function newAutomationLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations/new",
		params: { bot: bot.handle },
	});
}

/**
 * An automation's own page, where it is set up; its feed, where its runs post,
 * is opened first when it has none yet. With `itemPage`, one of its runs, by
 * the run's conversation, is the page instead.
 */
export function automationFeedLink(
	bot: BotRef,
	automationId: string,
	search: { itemPage?: string } = {},
) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations/$automation",
		params: { bot: bot.handle, automation: automationId },
		search,
	});
}

/** A connection's own page, under its bot's settings. */
export function connectionSettingsLink(bot: BotRef, connection: Pick<Connection, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/bots/$bot/connections/$connection",
		params: { bot: bot.handle, connection: connection.id },
	});
}

/** An automation run or collaboration opened from Inbox as a page of its own. */
export function inboxItemPageLink(rootConversationId: string, itemConversationId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./inbox/$conversation",
		params: { conversation: rootConversationId },
		search: { itemPage: itemConversationId },
	});
}

/** A message opened from Inbox in its conversation, jumped to, beside the list. */
export function inboxMessageLink(rootConversationId: string, messageId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./inbox/$conversation",
		params: { conversation: rootConversationId },
		search: { message: messageId },
	});
}

/** What a conversation's address keeps open beside it. */
export interface ConversationLinkSearch {
	item?: string;
	file?: string;
	tasks?: TasksTab;
}

function channelConversationLink(
	channel: ChannelRef,
	conversationId: string,
	search: ConversationLinkSearch,
) {
	return linkOptions({
		from: "/$workspace",
		to: "./channels/$channel/$conversation",
		params: { channel: channel.slug, conversation: conversationId },
		search,
	});
}

function taskLink(bot: BotRef, conversationId: string, search: ConversationLinkSearch) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/tasks/$conversation",
		params: { bot: bot.handle, conversation: conversationId },
		search,
	});
}

/**
 * A bot's task by its conversation's id alone, for a caller that does not know
 * which bot it belongs to; the route finds the bot and goes on to its address.
 */
export function taskByIdLink(conversationId: string, search: ConversationLinkSearch = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./tasks/$conversation",
		params: { conversation: conversationId },
		search,
	});
}

/**
 * A conversation where it belongs: a channel's main chat or thread, or a
 * bot's task, with `item` open beside it, or `file` open large. Called
 * with either, it is either; a caller holding one or the other branches.
 */
export function conversationLink(
	place: { channel: ChannelRef; conversationId: string },
	search?: ConversationLinkSearch,
): ReturnType<typeof channelConversationLink>;
export function conversationLink(
	place: { bot: BotRef; conversationId: string },
	search?: ConversationLinkSearch,
): ReturnType<typeof taskLink>;
export function conversationLink(
	place: Owner & { conversationId: string },
	search: ConversationLinkSearch = {},
) {
	return "channel" in place
		? channelConversationLink(place.channel, place.conversationId, search)
		: taskLink(place.bot, place.conversationId, search);
}

export function botSettingsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/bots/$bot",
		params: { bot: bot.handle },
	});
}

/** One of a bot's settings pages, General being the bot's own address. */
export function botSettingsPageLink(bot: BotRef, page: BotSettingsPage) {
	if (page === "general") return botSettingsLink(bot);
	return linkOptions({
		from: "/$workspace",
		to: "./settings/bots/$bot/$page",
		params: { bot: bot.handle, page },
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
export type TasksTab = "open" | "done";
