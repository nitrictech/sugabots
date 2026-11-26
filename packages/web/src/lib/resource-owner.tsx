import { useRender } from "@base-ui/react/use-render";
import type { Bot, Project, ResourcePermissions } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentProps, type ReactElement, useCallback } from "react";
import { useBot } from "@/lib/bots.ts";
import {
	botAutomationLink,
	botAutomationsLink,
	botComputerLink,
	botConnectorLink,
	botConnectorsLink,
	botFileLink,
	botFilesLink,
	botLink,
	botNewAutomationLink,
	botNewChatLink,
	botSettingsLink,
	chatLink,
	projectAutomationLink,
	projectAutomationsLink,
	projectComputerLink,
	projectConnectorLink,
	projectConnectorsLink,
	projectFileLink,
	projectFilesLink,
	projectLink,
	projectNewAutomationLink,
	projectNewChatLink,
	projectSettingsLink,
} from "@/lib/links.ts";

/*
 * A bot or a project, whose pages look and work alike. A project holds its
 * chats, files, computer, connectors and automations; a bot's are those of
 * its hidden default project, shown as the bot's own. So the pages for them
 * take either, and read the project they are about through here.
 */

/** A bot, shown as itself over its default project, or a project members made. */
export type ResourceOwner = { bot: Bot } | { project: Project };

/** The project whose chats, files, computer, connectors and automations these are. */
export function resourceProjectId(owner: ResourceOwner): string {
	return "bot" in owner ? owner.bot.defaultProjectId : owner.project.id;
}

/** What the owner is called. */
export function ownerName(owner: ResourceOwner): string {
	return "bot" in owner ? owner.bot.name : owner.project.name;
}

/** What the member may do with the owner's computer, connectors and automations, as the API resolved it. */
export function resourcePermissions(owner: ResourceOwner): ResourcePermissions {
	return "bot" in owner ? owner.bot.permissions.resources : owner.project.permissions.resources;
}

/**
 * The bot that works on the owner's chats and runs its automations: a bot
 * itself, or a project's lead bot. Undefined until the roster has it.
 */
export function useLeadBot(owner: ResourceOwner): Bot | undefined {
	const lead = useBot("project" in owner ? owner.project.leadBotId : null);
	return "bot" in owner ? owner.bot : lead;
}

/** One of the pages a bot and a project each have. */
export type OwnerPage =
	/** On a phone, the bot's or project's chats and pages; wider, a bot's new chat or a project's newest. */
	| { page: "home" }
	| { page: "newChat" }
	/** A chat, with `runChat`, one of the runs its automation's feed lists, in view. */
	| { page: "chat"; chatId: string; runChat?: string }
	| { page: "files" }
	/** One file, at `version` when one is given, else its current one. */
	| { page: "file"; fileId: string; version?: number }
	| { page: "automations" }
	| { page: "newAutomation" }
	/** An automation's own page, where it is set up. */
	| { page: "automation"; automationId: string }
	| { page: "connectors" }
	| { page: "connector"; connectorId: string }
	| { page: "computer" }
	| { page: "settings" };

/**
 * An address under the workspace, as any of the helpers in `links.ts` gives
 * one, with its route forgotten: the router can't check a union of routes, and
 * those helpers have already checked each.
 */
interface OwnerLinkOptions {
	from: "/$workspace";
	to: string;
	params: Readonly<Record<string, string>>;
	search?: object;
}

/**
 * The address of one of the owner's pages, to spread into a `Link` or give to
 * `navigate`. The router types each address apart, so a bot's and a project's
 * are told apart here once, rather than by every caller.
 */
export function ownerLinkOptions(owner: ResourceOwner, to: OwnerPage): OwnerLinkOptions {
	if ("bot" in owner) {
		const { bot } = owner;
		switch (to.page) {
			case "home":
				return botLink(bot);
			case "newChat":
				return botNewChatLink(bot);
			case "chat":
				return chatLink({ bot, chatId: to.chatId }, runChatSearch(to.runChat));
			case "files":
				return botFilesLink(bot);
			case "file":
				return botFileLink(bot, to.fileId, versionSearch(to.version));
			case "automations":
				return botAutomationsLink(bot);
			case "newAutomation":
				return botNewAutomationLink(bot);
			case "automation":
				return botAutomationLink(bot, to.automationId);
			case "connectors":
				return botConnectorsLink(bot);
			case "connector":
				return botConnectorLink(bot, { id: to.connectorId });
			case "computer":
				return botComputerLink(bot);
			case "settings":
				return botSettingsLink(bot);
		}
	}
	const { project } = owner;
	switch (to.page) {
		case "home":
			return projectLink(project);
		case "newChat":
			return projectNewChatLink(project);
		case "chat":
			return chatLink({ project, chatId: to.chatId }, runChatSearch(to.runChat));
		case "files":
			return projectFilesLink(project);
		case "file":
			return projectFileLink(project, to.fileId, versionSearch(to.version));
		case "automations":
			return projectAutomationsLink(project);
		case "newAutomation":
			return projectNewAutomationLink(project);
		case "automation":
			return projectAutomationLink(project, to.automationId);
		case "connectors":
			return projectConnectorsLink(project);
		case "connector":
			return projectConnectorLink(project, { id: to.connectorId });
		case "computer":
			return projectComputerLink(project);
		case "settings":
			return projectSettingsLink(project);
	}
}

/** A `Link` to one of the owner's pages, for a `render` prop or to wrap children in. */
export function ownerLink(owner: ResourceOwner, to: OwnerPage): ReactElement {
	return <Link {...ownerLinkOptions(owner, to)} />;
}

/** A run named in its feed's address, or nothing, so a link with none adds no `?runChat=`. */
function runChatSearch(runChat: string | undefined): { runChat?: string } {
	return runChat === undefined ? {} : { runChat };
}

/** A file's version named in its address, or nothing, so a link to its current one adds no `?version=`. */
function versionSearch(version: number | undefined): { version?: number } {
	return version === undefined ? {} : { version };
}

/** Goes to one of the owner's pages, as `ownerLink` links to it, in place of this one when `replace`. */
export function useNavigateToOwnerPage() {
	const navigate = useNavigate();
	return useCallback(
		(owner: ResourceOwner, to: OwnerPage, options: { replace?: boolean } = {}) =>
			navigate({ ...ownerLinkOptions(owner, to), ...options }),
		[navigate],
	);
}

/** `ownerLink`'s link with `props` of its own, such as its children and class. */
export function OwnerLink({
	owner,
	to,
	ref,
	...props
}: {
	owner: ResourceOwner;
	to: OwnerPage;
} & ComponentProps<"a">) {
	return useRender({ render: ownerLink(owner, to), props, ref });
}
