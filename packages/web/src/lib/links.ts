import type { Bot, Connector, Project } from "@sugabots/contracts";
import { linkOptions } from "@tanstack/react-router";
import {
	type SettingsLocation,
	type SettingsSearch,
	settingsSearchValue,
	withoutSettings,
} from "@/lib/open-settings.ts";
import type { SettingSection } from "@/lib/workspace-settings.ts";

/*
 * Where a project or a bot lives in the workspace being looked at.
 *
 * Built from the records rather than from loose params, so no caller assembles
 * an address by hand and the address can change here alone. Each result spreads
 * into a `Link` or goes to `navigate` from a page under `/$workspace`.
 *
 * Pages outside a workspace (workspace setup, the OAuth return) name one
 * themselves, and links by fixed key or chat id are written in place.
 */

type ProjectRef = Pick<Project, "slug">;
type BotRef = Pick<Bot, "handle"> | Pick<Bot, "handle" | "assistant" | "id" | "permissions">;

/** Administrative links need the id because each member can have assistants with the same handles. */
export function botRouteAddress(bot: BotRef): string {
	return "assistant" in bot && bot.assistant && !bot.permissions.talk ? `~${bot.id}` : bot.handle;
}

/** Every project the member could open or join. */
export function projectsLink() {
	return linkOptions({ from: "/$workspace", to: "./projects" });
}

/** Every bot the member reaches. */
export function botsLink() {
	return linkOptions({ from: "/$workspace", to: "./bots" });
}

/** A project, which opens its newest chat, or says it has none yet. */
export function projectLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project",
		params: { project: project.slug },
	});
}

/** A bot's own page: on a phone, its chats and pages; on a wider screen, starting a chat with it. */
export function botLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot",
		params: { bot: botRouteAddress(bot) },
	});
}

/** Starting a chat with a bot, from its first message. */
export function botNewChatLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/new",
		params: { bot: botRouteAddress(bot) },
	});
}

/** Starting a chat in a project, from its first message. */
export function projectNewChatLink(project: ProjectRef) {
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
		params: { bot: botRouteAddress(bot) },
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
		params: { bot: botRouteAddress(bot), file: fileId },
		search,
	});
}

/** A project's settings: its name, lead bot, look and visibility. */
export function projectSettingsLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/settings",
		params: { project: project.slug },
	});
}

/** The members in a project, a page of its settings. */
export function projectMembersLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/settings/members",
		params: { project: project.slug },
	});
}

/** The bots added to a project, a page of its settings. */
export function projectBotsLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/settings/bots",
		params: { project: project.slug },
	});
}

/** A project's computer: how it stands, its disk, and the hosts it may reach. */
export function projectComputerLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/computer",
		params: { project: project.slug },
	});
}

/** A bot's automations, listed as a page of their own. */
export function botAutomationsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations",
		params: { bot: botRouteAddress(bot) },
	});
}

/** An automation being made, as a page under its bot's automations. */
export function botNewAutomationLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations/new",
		params: { bot: botRouteAddress(bot) },
	});
}

/** An automation's own page, where it is set up. */
export function botAutomationLink(bot: BotRef, automationId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/automations/$automation",
		params: { bot: botRouteAddress(bot), automation: automationId },
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

/** One of a project's automations, as `botAutomationLink` is a bot's. */
export function projectAutomationLink(project: ProjectRef, automationId: string) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/automations/$automation",
		params: { project: project.slug, automation: automationId },
	});
}

/** The services a bot is connected to: its default project's. */
export function botConnectorsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/connectors",
		params: { bot: botRouteAddress(bot) },
	});
}

/** One of a bot's connectors, on its own page. */
export function botConnectorLink(bot: BotRef, connector: Pick<Connector, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/connectors/$connector",
		params: { bot: botRouteAddress(bot), connector: connector.id },
	});
}

/** The services a project is connected to. */
export function projectConnectorsLink(project: ProjectRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/connectors",
		params: { project: project.slug },
	});
}

/** One of a project's connectors, on its own page. */
export function projectConnectorLink(project: ProjectRef, connector: Pick<Connector, "id">) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/connectors/$connector",
		params: { project: project.slug, connector: connector.id },
	});
}

/** What a chat's address opens with it: one of its runs, by the run's chat, in view, or a file open large. */
export interface ChatLinkSearch {
	runChat?: string;
	file?: string;
}

function projectChatLink(project: ProjectRef, chatId: string, search: ChatLinkSearch) {
	return linkOptions({
		from: "/$workspace",
		to: "./projects/$project/$chat",
		params: { project: project.slug, chat: chatId },
		search,
	});
}

function botChatLink(bot: BotRef, chatId: string, search: ChatLinkSearch) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/chats/$chat",
		params: { bot: botRouteAddress(bot), chat: chatId },
		search,
	});
}

/**
 * A chat by its id alone, for a caller that does not know where it belongs;
 * the route finds its project or bot and goes on to its address.
 */
export function chatByIdLink(chatId: string, search: ChatLinkSearch = {}) {
	return linkOptions({
		from: "/$workspace",
		to: "./chats/$chat",
		params: { chat: chatId },
		search,
	});
}

/**
 * A chat where it belongs: a project's chat, or a bot's chat, with
 * `runChat` in view, or `file` open large. Called with either place, it is
 * either; a caller holding one or the other branches.
 */
export function chatLink(
	place: { project: ProjectRef; chatId: string },
	search?: ChatLinkSearch,
): ReturnType<typeof projectChatLink>;
export function chatLink(
	place: { bot: BotRef; chatId: string },
	search?: ChatLinkSearch,
): ReturnType<typeof botChatLink>;
export function chatLink(
	place: { project: ProjectRef; chatId: string } | { bot: BotRef; chatId: string },
	search: ChatLinkSearch = {},
) {
	return "project" in place
		? projectChatLink(place.project, place.chatId, search)
		: botChatLink(place.bot, place.chatId, search);
}

/** A bot's settings: its look, model, instructions and tools. */
export function botSettingsLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/settings",
		params: { bot: botRouteAddress(bot) },
	});
}

/** A bot's computer: its default project's. */
export function botComputerLink(bot: BotRef) {
	return linkOptions({
		from: "/$workspace",
		to: "./bots/$bot/computer",
		params: { bot: botRouteAddress(bot) },
	});
}

/**
 * A page of the settings, open over whatever page is open, which stays as it
 * is beneath them: the list of sections when no page is given.
 */
export function settingsLink(page: SettingsLocation = { kind: "sections" }) {
	return linkOptions({
		to: ".",
		search: (search: SettingsSearch) => ({ ...search, settings: settingsSearchValue(page) }),
	});
}

/** One section of the settings, as `settingsLink` opens it. */
export function settingsSectionLink(section: SettingSection["id"]) {
	return settingsLink({ kind: "section", section });
}

/** A member's page among the workspace's members, by their membership's id. */
export function memberSettingsLink(membership: { id: string }) {
	return settingsLink({ kind: "member", membership: membership.id });
}

/** The page beneath the settings, with them closed. */
export function closeSettingsLink() {
	return linkOptions({
		to: ".",
		search: (search: SettingsSearch) => withoutSettings(search),
	});
}
