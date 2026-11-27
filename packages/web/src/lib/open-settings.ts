import type { ParsedLocation } from "@tanstack/react-router";
import { useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { stepsBackTo } from "@/lib/history-trail.ts";
import { type SettingSection, workspaceSettingSection } from "@/lib/workspace-settings.ts";
import { decodeRouteId } from "@/routes/search.ts";

/*
 * Settings open over whatever page is open, which stays as it was beneath
 * them, so the address names them in its search rather than its path:
 * `?settings=members`, `?settings=members/<membership>`,
 * `?settings=providers/<provider>`, and `?settings=` alone for the list of
 * sections. Closing them takes the search away again.
 */

/** Which page of the settings is open. */
export type SettingsLocation =
	/** The list of sections, which from a laptop's width up opens General beside it. */
	| { kind: "sections" }
	| { kind: "section"; section: SettingSection["id"] }
	/** One member, by their membership's id. */
	| { kind: "member"; membership: string }
	/** One model provider, by its id. */
	| { kind: "provider"; provider: string }
	/** The model new bots start on, or the one the system bots share. */
	| { kind: "model"; choice: ModelChoice };

export type ModelChoice = "default" | "system";

/** The search key that names the open settings page. */
const SETTINGS_KEY = "settings";

/** What the shell's address keeps of its search: the open settings page, as written there. */
export interface SettingsSearch {
	settings?: string;
}

/** The shell route's search validation: `settings` when it is a string, which `settingsLocationOf` reads. */
export const validateSettingsSearch = (search: Record<string, unknown>): SettingsSearch =>
	typeof search[SETTINGS_KEY] === "string" ? { settings: search[SETTINGS_KEY] } : {};

/**
 * The settings page `value` names, from the address's `?settings=`, or
 * undefined when it names none and settings are closed. A section it does
 * not know opens the list.
 */
export function settingsLocationOf(value: unknown): SettingsLocation | undefined {
	if (typeof value !== "string") return undefined;
	const [sectionId = "", item] = value.split("/");
	const section = workspaceSettingSection(sectionId);
	if (!section) return { kind: "sections" };
	if (item === undefined || item === "") return { kind: "section", section: section.id };
	if (section.id === "members") return { kind: "member", membership: decodeRouteId(item) };
	if (section.id === "providers") {
		return item === "default" || item === "system"
			? { kind: "model", choice: item }
			: { kind: "provider", provider: decodeRouteId(item) };
	}
	return { kind: "section", section: section.id };
}

/** `page` as the address's `?settings=` writes it. */
export function settingsSearchValue(page: SettingsLocation): string {
	switch (page.kind) {
		case "sections":
			return "";
		case "section":
			return page.section;
		case "member":
			return `members/${page.membership}`;
		case "provider":
			return `providers/${page.provider}`;
		case "model":
			return `providers/${page.choice}`;
	}
}

/** The section `page` is in, or undefined for the list of sections. */
export function sectionOf(page: SettingsLocation): SettingSection["id"] | undefined {
	switch (page.kind) {
		case "sections":
			return undefined;
		case "section":
			return page.section;
		case "member":
			return "members";
		case "provider":
		case "model":
			return "providers";
	}
}

/** Whether `location` has settings open over its page. */
export function hasSettingsOpen(location: Pick<ParsedLocation, "search">): boolean {
	return settingsLocationOf((location.search as SettingsSearch).settings) !== undefined;
}

/** The settings page open over the page, or undefined while settings are closed. */
export function useOpenSettings(): SettingsLocation | undefined {
	const value = useSearch({ strict: false, select: (search) => search.settings });
	return useMemo(() => settingsLocationOf(value), [value]);
}

/** `search` with settings closed. */
export function withoutSettings<Search extends SettingsSearch>(
	search: Search,
): Omit<Search, "settings"> {
	const { settings: _closed, ...rest } = search;
	return rest;
}

/**
 * Closes settings onto the page beneath them. When they were opened over it
 * in this tab, that is going back through history to it, past every settings
 * page opened since, so the browser's Back from it goes where it went before
 * settings opened. Otherwise, as when the address came with them open, the
 * page takes their place in history.
 */
export function useCloseSettings(): () => void {
	const router = useRouter();
	return useCallback(() => {
		const location = router.state.location;
		const steps = stepsBackTo(
			router.history,
			location,
			(page) => page.pathname === location.pathname && !hasSettingsOpen(page),
			(page) => page.pathname === location.pathname,
		);
		if (steps !== undefined) {
			router.history.go(-steps);
			return;
		}
		void router.navigate({
			to: ".",
			search: (search: SettingsSearch) => withoutSettings(search),
			replace: true,
		});
	}, [router]);
}
