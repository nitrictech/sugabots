/** What the page shown for an unreachable server can ask of the main process, which its preload exposes as `window.unreachable`. */
export interface UnreachableBridge {
	/** Loads the server again, resolving to whether it answered. When it did, this page closes. */
	retry(): Promise<boolean>;
	/** Opens the menu of workspaces on the saved servers. */
	switchWorkspace(): Promise<void>;
}

export const unreachableChannels = {
	retry: "unreachable:retry",
	switchWorkspace: "unreachable:switch-workspace",
} as const;
