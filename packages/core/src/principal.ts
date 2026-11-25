/**
 * Who an operation acts for, as an entrypoint authenticated them. Operations
 * take one as their first argument; nothing about who is asking is ambient.
 *
 * Only `core/src/authentication/` builds a principal, through
 * {@link authenticated} (lint: `principals-only-in-authentication`). Each kind
 * is a class with a private field, exported only as a type, so neither an
 * object literal nor a spread copy with a field changed is a principal. Each
 * is frozen, and so is every object it holds.
 */

/** Keeps the kind in a private field, which a literal or a spread copy can't have. */
abstract class Authenticated<Tag extends string> {
	readonly #tag: Tag;

	constructor(tag: Tag) {
		this.#tag = tag;
	}

	get _tag(): Tag {
		return this.#tag;
	}
}

/**
 * What a bot acting for its asker, or an automation's run, may reach in a
 * turn, whatever its asker reaches. Its authenticator sets them from the turn.
 */
export type TurnBounds = ChatBounds | MemberBounds;

/**
 * Most turns' bounds, a helper's included: the turn's chat's project, and the
 * bot's own connectors. In a bot's own chats the project is its default
 * project.
 */
interface ChatBounds {
	readonly kind: "chat";
	readonly project: string;
}

/**
 * A Personal Assistant's own turns, and its automations' routine and manual
 * runs: everything its member reaches.
 */
interface MemberBounds {
	readonly kind: "member";
}

/** A member signed in, through the HTTP API, the event stream or the desktop viewer. */
class MemberSession extends Authenticated<"MemberSession"> {
	readonly member: string;
	/** The session they signed in with, which ends a stream when it ends. */
	readonly session: string;

	constructor(fields: Omit<MemberSession, "_tag">) {
		super("MemberSession");
		this.member = fields.member;
		this.session = fields.session;
		Object.freeze(this);
	}
}

/**
 * A bot in a turn, acting for its asker: the member who wrote the message the
 * turn answers, or the asker of the turn that wrote it. It has only the
 * permissions both the asker and the bot have, within its bounds.
 */
class BotForAsker extends Authenticated<"BotForAsker"> {
	readonly workspace: string;
	readonly bot: string;
	readonly asker: string;
	/** Whether the turn answers an automation's trigger for a Personal Assistant's member. */
	readonly askedByAutomation: boolean;
	readonly chat: string;
	readonly turn: string;
	/**
	 * Which execution of the turn this is: its authenticator raises the turn's
	 * number each time it starts or resumes, and every write the turn makes
	 * checks it is still the current one.
	 */
	readonly executionNumber: number;
	readonly bounds: TurnBounds;

	constructor(fields: Omit<BotForAsker, "_tag">) {
		super("BotForAsker");
		this.workspace = fields.workspace;
		this.bot = fields.bot;
		this.asker = fields.asker;
		this.askedByAutomation = fields.askedByAutomation;
		this.chat = fields.chat;
		this.turn = fields.turn;
		this.executionNumber = fields.executionNumber;
		this.bounds = Object.freeze({ ...fields.bounds });
		Object.freeze(this);
	}
}

/**
 * A bot in an automation's run, which answers no member: the automation's
 * project's lead bot, or a bot it asked for help in the run's chat. Its bounds are those a turn
 * in the run's chat would have: the automation's project. A Personal
 * Assistant's runs act for its member instead, as a {@link BotForAsker}.
 */
class AutomationRun extends Authenticated<"AutomationRun"> {
	readonly workspace: string;
	readonly bot: string;
	readonly automation: string;
	readonly run: string;
	readonly chat: string;
	readonly turn: string;
	/** Which execution of the turn this is (see `BotForAsker.executionNumber`). */
	readonly executionNumber: number;
	readonly bounds: ChatBounds;

	constructor(fields: Omit<AutomationRun, "_tag">) {
		super("AutomationRun");
		this.workspace = fields.workspace;
		this.bot = fields.bot;
		this.automation = fields.automation;
		this.run = fields.run;
		this.chat = fields.chat;
		this.turn = fields.turn;
		this.executionNumber = fields.executionNumber;
		this.bounds = Object.freeze({ ...fields.bounds });
		Object.freeze(this);
	}
}

/**
 * What signed a webhook call, which is all it reaches: an automation's
 * trigger, or a project's GitHub app (its GitHub connector).
 */
export type WebhookSource =
	| {
			readonly kind: "trigger";
			readonly trigger: string;
			readonly automation: string;
			readonly project: string;
	  }
	| { readonly kind: "github"; readonly connector: string; readonly project: string };

/** A webhook call whose secret was checked, or one to a webhook left without a secret. */
class WebhookCall extends Authenticated<"WebhookCall"> {
	readonly workspace: string;
	readonly source: WebhookSource;

	constructor(fields: Omit<WebhookCall, "_tag">) {
		super("WebhookCall");
		this.workspace = fields.workspace;
		this.source = Object.freeze({ ...fields.source });
		Object.freeze(this);
	}
}

export type DeletionTarget =
	| { readonly kind: "workspace"; readonly id: string }
	| { readonly kind: "project"; readonly id: string };

/** The work a {@link SystemWork} was stored to do, which is all it reaches. */
export type StoredWork =
	| { readonly kind: "compaction"; readonly chat: string }
	| { readonly kind: "computerSleep"; readonly computer: string; readonly project: string }
	| {
			readonly kind: "dueRoutine";
			readonly automation: string;
			readonly trigger: string;
			readonly project: string;
	  }
	| { readonly kind: "pauseAfterFailures"; readonly automation: string; readonly project: string }
	| { readonly kind: "approvalExpiry"; readonly approval: string }
	| { readonly kind: "gitHubUninstall"; readonly uninstall: string }
	| { readonly kind: "deletion"; readonly targetKind: DeletionTarget["kind"]; readonly id: string };

/** Work Sugabots does on its own: a system bot's, or upkeep, started from a stored request. */
class SystemWork extends Authenticated<"SystemWork"> {
	readonly workspace: string;
	readonly work: StoredWork;

	constructor(fields: Omit<SystemWork, "_tag">) {
		super("SystemWork");
		this.workspace = fields.workspace;
		this.work = Object.freeze({ ...fields.work });
		Object.freeze(this);
	}
}

/** Whoever holds a bot-made page's secret address, which opens only that version of that page. */
class PageAddress extends Authenticated<"PageAddress"> {
	readonly workspace: string;
	readonly file: string;
	readonly version: number;

	constructor(fields: Omit<PageAddress, "_tag">) {
		super("PageAddress");
		this.workspace = fields.workspace;
		this.file = fields.file;
		this.version = fields.version;
		Object.freeze(this);
	}
}

export type { AutomationRun, BotForAsker, MemberSession, PageAddress, SystemWork, WebhookCall };

export type Principal =
	| MemberSession
	| BotForAsker
	| AutomationRun
	| WebhookCall
	| SystemWork
	| PageAddress;

/** A bot in a turn: acting for its asker, or in an automation's run. */
export type BotPrincipal = BotForAsker | AutomationRun;

/**
 * Builds principals once an entrypoint has authenticated the caller. Only
 * `core/src/authentication/` may call these.
 */
export const authenticated = {
	memberSession: (fields: Omit<MemberSession, "_tag">) => new MemberSession(fields),
	botForAsker: (fields: Omit<BotForAsker, "_tag">) => new BotForAsker(fields),
	automationRun: (fields: Omit<AutomationRun, "_tag">) => new AutomationRun(fields),
	webhookCall: (fields: Omit<WebhookCall, "_tag">) => new WebhookCall(fields),
	systemWork: (fields: Omit<SystemWork, "_tag">) => new SystemWork(fields),
	pageAddress: (fields: Omit<PageAddress, "_tag">) => new PageAddress(fields),
};
