import { useRender } from "@base-ui/react/use-render";
import type { Bot, Project, ResourcePermissions } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentProps, type ReactElement, useCallback } from "react";
import { useBot } from "@/lib/bots.ts";
import {
	botAutomationFeedLink,
	botAutomationsLink,
	botComputerLink,
	botConnectionLink,
	botConnectionsLink,
	botFileLink,
	botFilesLink,
	botLink,
	botNewAutomationLink,
	botNewThreadLink,
	botSettingsLink,
	conversationLink,
	projectAutomationFeedLink,
	projectAutomationsLink,
	projectComputerLink,
	projectConnectionLink,
	projectConnectionsLink,
	projectFileLink,
	projectFilesLink,
	projectLink,
	projectNewAutomationLink,
	projectNewThreadLink,
	projectSettingsLink,
} from "@/lib/links.ts";

/*
 * A bot or a project, whose pages look and work alike. A project holds its
 * threads, files, computer, connections and automations; a bot's are those of
 * its hidden default project, shown as the bot's own. So the pages for them
 * take either, and read the project they are about through here.
 */

/** A bot, shown as itself over its default project, or a project people made. */
export type ResourceOwner = { bot: Bot } | { project: Project };

/** The project whose threads, files, computer, connections and automations these are. */
export function resourceProjectId(owner: ResourceOwner): string {
	return "bot" in owner ? owner.bot.defaultProjectId : owner.project.id;
}

/** What the owner is called. */
export function ownerName(owner: ResourceOwner): string {
	return "bot" in owner ? owner.bot.name : owner.project.name;
}

/** What the person may do with the owner's computer, connections and automations, as the API resolved it. */
export function resourcePermissions(owner: ResourceOwner): ResourcePermissions {
	return "bot" in owner ? owner.bot.permissions.resources : owner.project.permissions.resources;
}

/**
 * The bot that works on the owner's threads and runs its automations: a bot
 * itself, or a project's lead bot. Undefined until the roster has it, or
 * while the project has no lead bot.
 */
export function useLeadBot(owner: ResourceOwner): Bot | undefined {
	const lead = useBot("project" in owner ? owner.project.leadBotId : null);
	return "bot" in owner ? owner.bot : lead;
}

/** One of the pages a bot and a project each have. */
export type OwnerPage =
	/** On a phone, the bot's or project's threads and pages; wider, a bot's new thread or a project's newest. */
	| { page: "home" }
	| { page: "newThread" }
	| { page: "thread"; conversationId: string }
	| { page: "files" }
	/** One file, at `version` when one is given, else its current one. */
	| { page: "file"; fileId: string; version?: number }
	| { page: "automations" }
	| { page: "newAutomation" }
	/** An automation's own page, or with `itemPage` one of its runs. */
	| { page: "automation"; automationId: string; itemPage?: string }
	| { page: "connections" }
	| { page: "connection"; connectionId: string }
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
			case "newThread":
				return botNewThreadLink(bot);
			case "thread":
				return conversationLink({ bot, conversationId: to.conversationId });
			case "files":
				return botFilesLink(bot);
			case "file":
				return botFileLink(bot, to.fileId, versionSearch(to.version));
			case "automations":
				return botAutomationsLink(bot);
			case "newAutomation":
				return botNewAutomationLink(bot);
			case "automation":
				return botAutomationFeedLink(bot, to.automationId, itemPageSearch(to.itemPage));
			case "connections":
				return botConnectionsLink(bot);
			case "connection":
				return botConnectionLink(bot, { id: to.connectionId });
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
		case "newThread":
			return projectNewThreadLink(project);
		case "thread":
			return conversationLink({ project, conversationId: to.conversationId });
		case "files":
			return projectFilesLink(project);
		case "file":
			return projectFileLink(project, to.fileId, versionSearch(to.version));
		case "automations":
			return projectAutomationsLink(project);
		case "newAutomation":
			return projectNewAutomationLink(project);
		case "automation":
			return projectAutomationFeedLink(project, to.automationId, itemPageSearch(to.itemPage));
		case "connections":
			return projectConnectionsLink(project);
		case "connection":
			return projectConnectionLink(project, { id: to.connectionId });
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

/** A run named in an automation's address, or nothing, so a link with none adds no `?itemPage=`. */
function itemPageSearch(itemPage: string | undefined): { itemPage?: string } {
	return itemPage === undefined ? {} : { itemPage };
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
