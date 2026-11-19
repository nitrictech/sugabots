import type { Bot, Connection, Project } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";
import type { BotSettingsPage, ProjectSettingsPage } from "@/lib/workspace-settings.ts";

/*
 * Where a project or a bot lives in the workspace being looked at.
 *
 * Built from the records rather than from loose params, so no caller assembles
 * an address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate` from a page under `/$workspace`.
 *
 * Pages outside a workspace (onboarding, the OAuth return) name one
 * themselves, and links by fixed key or conversation id are written in place.
 */

type ProjectRef = Pick<Project, "slug">;
type BotRef = Pick<Bot, "handle">;

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
 * is given. The address names no project, as a direct message between people
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

/** Every project the person could open or join. */
export function projectsLink() {
	return linkOptions({ from: "/$workspace", to: "./projects" });
}

/** Every bot the person reaches. */
export function botsLink() {
	return linkOptions({ from: "/$workspace", to: "./bots" });
}

/** A project, which opens its newest thread, or says it has none yet. */
export function projectLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project",
		params: { project: project.slug },
	});
}

/** A bot's own page, where a thread with it starts. */
export function botLink(bot: BotRef) {
	return linkOptions({ from: "/$workspace", to: "./bots/$bot", params: { bot: bot.handle } });
}

/** Starting a thread in a project, from its first message. */
export function projectNewThreadLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/new",
		params: { project: project.slug },
	});
}

/** A project's files. */
export function projectFilesLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/files",
		params: { project: project.slug },
	});
}

/** A bot's files: its default project's. */
export function botFilesLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/files",
		params: { bot: bot.handle },
	});
}

/** One of a project's files, at `version` when one is given. */
export function projectFileLink(
	project: ProjectRef,
	fileId: string,
	search: { version?: number } = {},
) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/files/$file",
		params: { project: project.slug, file: fileId },
		search,
	});
}

/** One of a bot's files, at `version` when one is given. */
export function botFileLink(bot: BotRef, fileId: string, search: { version?: number } = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/files/$file",
		params: { bot: bot.handle, file: fileId },
		search,
	});
}

export function projectSettingsLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./settings/projects/$project",
		params: { project: project.slug },
	});
}

/** One of a project's settings pages, General being the project's own address. */
export function projectSettingsPageLink(project: ProjectRef, page: ProjectSettingsPage) {
	if (page === "general") return projectSettingsLink(project);
	return linkOptions({
		from: "/$workspace",
		to: "./settings/projects/$project/$page",
		params: { project: project.slug, page },
	});
}

/** A bot's automations, listed as a page of their own. */
export function botAutomationsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations",
		params: { bot: bot.handle },
	});
}

/** An automation being made, as a page under its bot's automations. */
export function botNewAutomationLink(bot: BotRef) {
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
export function botAutomationFeedLink(
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

/** A project's automations, listed as a page of their own. */
export function projectAutomationsLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/automations",
		params: { project: project.slug },
	});
}

/** An automation being made, as a page under its project's automations. */
export function projectNewAutomationLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/automations/new",
		params: { project: project.slug },
	});
}

/** One of a project's automations, as `botAutomationFeedLink` is a bot's. */
export function projectAutomationFeedLink(
	project: ProjectRef,
	automationId: string,
	search: { itemPage?: string } = {},
) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/automations/$automation",
		params: { project: project.slug, automation: automationId },
		search,
	});
}

/** The services a bot is connected to: its default project's. */
export function botConnectionsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/connections",
		params: { bot: bot.handle },
	});
}

/** One of a bot's connections, on its own page. */
export function botConnectionLink(bot: BotRef, connection: Pick<Connection, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/connections/$connection",
		params: { bot: bot.handle, connection: connection.id },
	});
}

/** The services a project is connected to. */
export function projectConnectionsLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/connections",
		params: { project: project.slug },
	});
}

/** One of a project's connections, on its own page. */
export function projectConnectionLink(project: ProjectRef, connection: Pick<Connection, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/connections/$connection",
		params: { project: project.slug, connection: connection.id },
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
}

function projectThreadLink(
	project: ProjectRef,
	conversationId: string,
	search: ConversationLinkSearch,
) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/$conversation",
		params: { project: project.slug, conversation: conversationId },
		search,
	});
}

function botThreadLink(bot: BotRef, conversationId: string, search: ConversationLinkSearch) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/threads/$conversation",
		params: { bot: bot.handle, conversation: conversationId },
		search,
	});
}

/**
 * A bot's thread by its conversation's id alone, for a caller that does not know
 * which bot it belongs to; the route finds the bot and goes on to its address.
 */
export function threadByIdLink(conversationId: string, search: ConversationLinkSearch = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./threads/$conversation",
		params: { conversation: conversationId },
		search,
	});
}

/**
 * A conversation where it belongs: a project's thread, or a
 * bot's thread, with `item` open beside it, or `file` open large. Called
 * with either, it is either; a caller holding one or the other branches.
 */
export function conversationLink(
	place: { project: ProjectRef; conversationId: string },
	search?: ConversationLinkSearch,
): ReturnType<typeof projectThreadLink>;
export function conversationLink(
	place: { bot: BotRef; conversationId: string },
	search?: ConversationLinkSearch,
): ReturnType<typeof botThreadLink>;
export function conversationLink(
	place: { project: ProjectRef; conversationId: string } | { bot: BotRef; conversationId: string },
	search: ConversationLinkSearch = {},
) {
	return "project" in place
		? projectThreadLink(place.project, place.conversationId, search)
		: botThreadLink(place.bot, place.conversationId, search);
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
