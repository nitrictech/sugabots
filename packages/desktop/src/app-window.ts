import {
	BaseWindow,
	type HandlerDetails,
	type Rectangle,
	type Session,
	session,
	shell,
	WebContentsView,
	type WindowOpenHandlerResponse,
} from "electron";
import { loadLocalPage, localPreload } from "./local-page.ts";
import { ServerId } from "./saved-servers.ts";
import { type SwitcherAccount, switcherChannels } from "./switcher/bridge.ts";
import { unreachableChannels } from "./unreachable/bridge.ts";

/** Chromium's error for a load that a newer navigation replaced, which isn't a failure. */
const ERR_ABORTED = -3;

/** Lets the page under the switcher show through around its card. */
const TRANSPARENT = "#00000000";

/** What the workspace switcher shows and does, which the rest of the app provides. */
export interface SwitcherHandlers {
	accounts(): SwitcherAccount[];
	/** Opens workspace `slug` of the saved server `id`, or with no slug, that server where it was left. */
	open(id: ServerId, slug: string | undefined): void;
	addAccount(): void;
}

/** A page of a server to show, signed in with the session of the saved server `id`. */
export interface ServerToShow {
	readonly id: ServerId;
	readonly url: string;
}

/** What the app window leaves to the rest of the app. */
export interface AppWindowEvents {
	/** The window title for a server's page title. */
	title(pageTitle: string, id: ServerId): string;
	/** The shown server's page moved to `url`, by a link or by its own script. */
	navigated(id: ServerId, url: string): void;
	/** The person asked to switch workspaces from the page that says a server can't be reached. */
	switchWorkspace(): void;
	closed(): void;
}

interface ServerView {
	readonly id: ServerId;
	readonly view: WebContentsView;
}

interface UnreachableView {
	readonly view: WebContentsView;
	/** The page that failed to load, which trying again loads. */
	url: string;
}

/**
 * The window that shows one saved server at a time. Each saved server's page
 * runs in its own session, so switching back finds the person still signed
 * in, and two saves of one server stay signed in to two accounts.
 */
export class AppWindow {
	readonly window = new BaseWindow({ title: "Sugabots", width: 1280, height: 820 });
	readonly #events: AppWindowEvents;
	#server: ServerView;
	#unreachable: UnreachableView | undefined;
	#switcher: WebContentsView | undefined;
	#pageTitle = "Sugabots";

	constructor(server: ServerToShow, events: AppWindowEvents) {
		this.#events = events;
		this.#server = this.#openServerView(server);
		this.window.on("resize", () => this.#layout());
		this.window.on("closed", () => {
			// A window's views outlive it unless they're closed.
			this.#server.view.webContents.close();
			this.#unreachable?.view.webContents.close();
			this.#switcher?.webContents.close();
			this.#events.closed();
		});
	}

	/** The saved server the window shows. */
	get serverId(): ServerId {
		return this.#server.id;
	}

	/** Opens `server.url`, in the page already open when it's of the same saved server. */
	show(server: ServerToShow): void {
		this.closeSwitcher();
		if (server.id === this.serverId) {
			void this.#load(server.url);
			return;
		}
		const previous = this.#server;
		this.#closeUnreachable();
		this.#pageTitle = "Sugabots";
		this.#server = this.#openServerView(server);
		this.window.contentView.removeChildView(previous.view);
		previous.view.webContents.close();
		this.refreshTitle();
	}

	/** Reloads the page, or tries an unreachable server again. */
	reload(): void {
		if (this.#unreachable) void this.#load(this.#unreachable.url);
		else this.#server.view.webContents.reload();
	}

	refreshTitle(): void {
		this.window.setTitle(this.#events.title(this.#pageTitle, this.serverId));
	}

	bringToFront(): void {
		bringToFront(this.window);
		this.#focusTopView();
	}

	/** Shows the workspace switcher over the page, until the person picks a place, presses Esc or clicks outside it. */
	showSwitcher(handlers: SwitcherHandlers): void {
		if (this.#switcher) {
			this.#switcher.webContents.focus();
			return;
		}
		const view = new WebContentsView({ webPreferences: { preload: localPreload("switcher") } });
		view.setBackgroundColor(TRANSPARENT);
		const { ipc } = view.webContents;
		ipc.handle(switcherChannels.accounts, () => handlers.accounts());
		ipc.handle(switcherChannels.open, (_event, id: unknown, slug: unknown) => {
			if (typeof id !== "string" || (slug !== undefined && typeof slug !== "string")) return;
			// After the reply is sent, since closing the switcher closes the page waiting for it.
			setImmediate(() => {
				this.closeSwitcher();
				handlers.open(ServerId.make(id), slug);
			});
		});
		ipc.handle(switcherChannels.addAccount, () => {
			setImmediate(() => {
				this.closeSwitcher();
				handlers.addAccount();
			});
		});
		ipc.handle(switcherChannels.close, () => {
			setImmediate(() => this.closeSwitcher());
		});
		this.#switcher = view;
		this.window.contentView.addChildView(view);
		view.setBounds(this.#viewBounds());
		void loadLocalPage(view.webContents, "switcher");
		view.webContents.focus();
	}

	closeSwitcher(): void {
		if (!this.#switcher) return;
		const view = this.#switcher;
		this.#switcher = undefined;
		this.window.contentView.removeChildView(view);
		view.webContents.close();
		this.#focusTopView();
	}

	/** Tells the switcher, if it's showing, to list the saved accounts again. */
	switcherAccountsChanged(): void {
		this.#switcher?.webContents.send(switcherChannels.accountsChanged);
	}

	#focusTopView(): void {
		(this.#switcher ?? this.#unreachable?.view ?? this.#server.view).webContents.focus();
	}

	#openServerView({ id, url }: ServerToShow): ServerView {
		const view = new WebContentsView({ webPreferences: { session: savedServerSession(id) } });
		const server = { id, view };
		const { webContents } = view;
		webContents.setWindowOpenHandler(openInBrowser);
		webContents.on("page-title-updated", (_event, title) => {
			this.#pageTitle = title;
			this.refreshTitle();
		});
		webContents.on("did-navigate", (_event, page) => this.#events.navigated(id, page));
		webContents.on("did-navigate-in-page", (_event, page, isMainFrame) => {
			if (isMainFrame) this.#events.navigated(id, page);
		});
		webContents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) => {
			if (isMainFrame && errorCode !== ERR_ABORTED && server === this.#server) {
				this.#showUnreachable(url, errorDescription);
			}
		});
		this.window.contentView.addChildView(view);
		view.setBounds(this.#viewBounds());
		void this.#load(url, server);
		return server;
	}

	/** Loads `url` in the server's page, resolving to whether it loaded. */
	async #load(url: string, server = this.#server): Promise<boolean> {
		try {
			await server.view.webContents.loadURL(url);
		} catch {
			// did-fail-load has shown why, unless a newer navigation replaced this one.
			return false;
		}
		if (server === this.#server) this.#closeUnreachable();
		return true;
	}

	#showUnreachable(url: string, errorDescription: string): void {
		if (this.#unreachable) {
			// Already showing, so trying again and failing keeps the page as it is.
			this.#unreachable.url = url;
			return;
		}
		const view = new WebContentsView({ webPreferences: { preload: localPreload("unreachable") } });
		const { ipc } = view.webContents;
		ipc.handle(unreachableChannels.retry, () => this.#load(this.#unreachable?.url ?? url));
		ipc.handle(unreachableChannels.switchWorkspace, () => {
			this.#events.switchWorkspace();
		});
		this.#unreachable = { view, url };
		this.window.contentView.addChildView(view);
		// Adding a view the window already holds moves it back to the top.
		if (this.#switcher) this.window.contentView.addChildView(this.#switcher);
		view.setBounds(this.#viewBounds());
		const query = { host: new URL(url).host, error: errorDescription };
		void loadLocalPage(view.webContents, "unreachable", query);
		this.#focusTopView();
	}

	#closeUnreachable(): void {
		if (!this.#unreachable) return;
		const { view } = this.#unreachable;
		this.#unreachable = undefined;
		this.window.contentView.removeChildView(view);
		view.webContents.close();
		this.#focusTopView();
	}

	#layout(): void {
		const bounds = this.#viewBounds();
		this.#server.view.setBounds(bounds);
		this.#unreachable?.view.setBounds(bounds);
		this.#switcher?.setBounds(bounds);
	}

	/** The whole of the window's content area, which each view fills. */
	#viewBounds(): Rectangle {
		const { width, height } = this.window.getContentBounds();
		return { x: 0, y: 0, width, height };
	}
}

/** The persistent session that keeps one saved server's sign-in, cookies and storage. */
export function savedServerSession(id: ServerId): Session {
	return session.fromPartition(`persist:server-${id}`);
}

export function bringToFront(window: BaseWindow): void {
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

/** Links the app opens in a new tab, such as docs and provider sign-ins, belong in the person's browser. */
function openInBrowser({ url }: HandlerDetails): WindowOpenHandlerResponse {
	// Other schemes can launch local programs, and the app shows links bots wrote.
	const { protocol } = new URL(url);
	if (protocol === "https:" || protocol === "http:") void shell.openExternal(url);
	return { action: "deny" };
}
