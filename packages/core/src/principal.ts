/**
 * Who an operation acts for, as an entrypoint authenticated them. Operations
 * take one as their first argument; nothing about who is asking is ambient.
 *
 * Only `core/src/authentication/` builds a principal, through
 * {@link authenticated} (lint: `principals-only-in-authentication`). Each kind
 * is a class with a private field, exported only as a type, so neither an
 * object literal nor a spread copy with a field changed is a principal.
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

/** A member signed in, through the HTTP API or the event stream. */
class MemberSession extends Authenticated<"MemberSession"> {
	readonly member: string;

	constructor(fields: { readonly member: string }) {
		super("MemberSession");
		this.member = fields.member;
		Object.freeze(this);
	}
}

/**
 * A bot in a turn, acting for its asker: the member who wrote the message the
 * turn answers. It has only the permissions both the asker and the bot have.
 */
class BotForAsker extends Authenticated<"BotForAsker"> {
	readonly workspace: string;
	readonly bot: string;
	readonly asker: string;
	readonly chat: string;
	readonly turn: string;

	constructor(fields: Omit<BotForAsker, "_tag">) {
		super("BotForAsker");
		this.workspace = fields.workspace;
		this.bot = fields.bot;
		this.asker = fields.asker;
		this.chat = fields.chat;
		this.turn = fields.turn;
		Object.freeze(this);
	}
}

/**
 * A bot in an automation's run, which answers no member. `bot` is the
 * project's lead bot, or a bot it asked for help in the run's chat.
 */
class AutomationRun extends Authenticated<"AutomationRun"> {
	readonly workspace: string;
	readonly bot: string;
	readonly automation: string;
	readonly run: string;
	readonly project: string;
	readonly chat: string;
	readonly turn: string;

	constructor(fields: Omit<AutomationRun, "_tag">) {
		super("AutomationRun");
		this.workspace = fields.workspace;
		this.bot = fields.bot;
		this.automation = fields.automation;
		this.run = fields.run;
		this.project = fields.project;
		this.chat = fields.chat;
		this.turn = fields.turn;
		Object.freeze(this);
	}
}

/** Who signed a webhook call: an automation's trigger, the GitHub app or a connector. */
export type WebhookSource =
	| { readonly kind: "trigger"; readonly triggerId: string }
	| { readonly kind: "github"; readonly installationId: string }
	| { readonly kind: "connector"; readonly connectorId: string };

/** A webhook call whose signature over its body was checked. */
class WebhookCall extends Authenticated<"WebhookCall"> {
	readonly source: WebhookSource;

	constructor(fields: { readonly source: WebhookSource }) {
		super("WebhookCall");
		this.source = fields.source;
		Object.freeze(this);
	}
}

export type { AutomationRun, BotForAsker, MemberSession, WebhookCall };

export type Principal = MemberSession | BotForAsker | AutomationRun | WebhookCall;

/**
 * Builds principals once an entrypoint has authenticated the caller. Only
 * `core/src/authentication/` may call these.
 */
export const authenticated = {
	memberSession: (fields: { readonly member: string }) => new MemberSession(fields),
	botForAsker: (fields: Omit<BotForAsker, "_tag">) => new BotForAsker(fields),
	automationRun: (fields: Omit<AutomationRun, "_tag">) => new AutomationRun(fields),
	webhookCall: (fields: { readonly source: WebhookSource }) => new WebhookCall(fields),
};
