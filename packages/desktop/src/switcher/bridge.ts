/** A saved account, with the workspaces it was last in. */
export interface SwitcherAccount {
	/** The saved server it's signed in to, which `SwitcherBridge.open` takes. */
	readonly id: string;
	readonly host: string;
	/** Who it's signed in as, or undefined while it's signed out. */
	readonly account: string | undefined;
	/** Whether the app window shows a page of it. */
	readonly open: boolean;
	readonly workspaces: readonly SwitcherWorkspace[];
}

export interface SwitcherWorkspace {
	readonly slug: string;
	readonly name: string;
	/** Whether the app window shows it. */
	readonly open: boolean;
}

/** What the workspace switcher can ask of the main process, which its preload exposes as `window.switcher`. */
export interface SwitcherBridge {
	/** Every saved account, in the Workspace menu's order. */
	accounts(): Promise<readonly SwitcherAccount[]>;
	/** Closes the switcher and opens workspace `slug` of account `id`, or with no slug, that account where it was left. */
	open(id: string, slug: string | undefined): Promise<void>;
	/** Closes the switcher and asks for another account's server. */
	addAccount(): Promise<void>;
	close(): Promise<void>;
	/** Calls `listener` whenever the accounts change, as when a sign-in reports its workspaces. */
	onAccountsChanged(listener: () => void): void;
}

export const switcherChannels = {
	accounts: "switcher:accounts",
	open: "switcher:open",
	addAccount: "switcher:add-account",
	close: "switcher:close",
	accountsChanged: "switcher:accounts-changed",
} as const;
