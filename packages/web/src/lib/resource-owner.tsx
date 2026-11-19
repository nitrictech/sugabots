import { useRender } from "@base-ui/react/use-render";
import type { Bot, Project } from "@sugabots/contracts";
import { type HistoryState, Link, useNavigate } from "@tanstack/react-router";
import { type ComponentProps, type ReactElement, useCallback } from "react";
import { useBot } from "@/lib/bots.ts";
import {
	botAutomationFeedLink,
	botAutomationsLink,
	botConnectionSettingsLink,
	botFileLink,
	botFilesLink,
	botLink,
	botNewAutomationLink,
	botSettingsLink,
	botSettingsPageLink,
	conversationLink,
	projectAutomationFeedLink,
	projectAutomationsLink,
	projectConnectionSettingsLink,
	projectFileLink,
	projectFilesLink,
	projectLink,
	projectNewAutomationLink,
	projectNewThreadLink,
	projectSettingsLink,
	projectSettingsPageLink,
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
interface ResourcePermissions {
	manageConnections: boolean;
	manageComputer: boolean;
	useDesktop: boolean;
	manageAutomations: boolean;
	runAutomations: boolean;
	/** Read its threads and what its automations' runs said, which managing them alone does not give. */
	readHistory: boolean;
	/** Open its settings: a bot's for whoever may change it, a project's for anyone in it. */
	openSettings: boolean;
	/** Delete the files written in its threads. */
	deleteFiles: boolean;
}

export function resourcePermissions(owner: ResourceOwner): ResourcePermissions {
	if ("bot" in owner) {
		const may = owner.bot.permissions;
		return {
			manageConnections: may.manageConnections,
			manageComputer: may.manageComputer,
			useDesktop: may.useDesktop,
			manageAutomations: may.manageAutomations,
			runAutomations: may.runAutomations,
			readHistory: may.talk,
			openSettings: may.update,
			deleteFiles: may.update,
		};
	}
	const may = owner.project.permissions;
	return {
		manageConnections: may.manageConnections,
		manageComputer: may.manageComputer,
		useDesktop: may.useDesktop,
		manageAutomations: may.manageAutomations,
		runAutomations: may.runAutomations,
		readHistory: owner.project.isMember,
		openSettings: owner.project.isMember,
		deleteFiles: may.deleteFiles,
	};
}

/**
 * The bot that works on the owner's threads and runs its automations: a bot
 * itself, a project's lead bot once the roster has it. Undefined for a project
 * from before leads that has none yet.
 */
export function useLeadBot(owner: ResourceOwner): Bot | undefined {
	const lead = useBot("project" in owner ? owner.project.leadBotId : null);
	return "bot" in owner ? owner.bot : lead;
}

/** One of the pages a bot and a project each have. */
export type OwnerPage =
	/** A bot's own page, or a project's newest thread. */
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
			case "newThread":
				return botLink(bot);
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
				return botSettingsPageLink(bot, "connections");
			case "connection":
				return botConnectionSettingsLink(bot, { id: to.connectionId });
			case "computer":
				return botSettingsPageLink(bot, "computer");
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
			return projectSettingsPageLink(project, "connections");
		case "connection":
			return projectConnectionSettingsLink(project, { id: to.connectionId });
		case "computer":
			return projectSettingsPageLink(project, "computer");
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

/** History state for the entry a link or navigation opens, as `useBackToHere` writes it. */
type NextHistoryState = (state: HistoryState) => HistoryState;

/** Goes to one of the owner's pages, as `ownerLink` links to it, in place of this one when `replace`. */
export function useNavigateToOwnerPage() {
	const navigate = useNavigate();
	return useCallback(
		(
			owner: ResourceOwner,
			to: OwnerPage,
			options: { replace?: boolean; state?: NextHistoryState } = {},
		) => navigate({ ...ownerLinkOptions(owner, to), ...options }),
		[navigate],
	);
}

/**
 * `ownerLink`'s link with `props` of its own, such as its children and class,
 * and `state` for the history entry it opens.
 */
export function OwnerLink({
	owner,
	to,
	state,
	ref,
	...props
}: {
	owner: ResourceOwner;
	to: OwnerPage;
	state?: NextHistoryState;
} & ComponentProps<"a">) {
	return useRender({ render: ownerLink(owner, to), props: { ...props, state }, ref });
}
