import {
	type AnyRouter,
	type HistoryState,
	type ParsedLocation,
	useLocation,
	useRouter,
} from "@tanstack/react-router";
import { createContext, type MouseEvent, type ReactNode, useContext, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useWorkspace, useWorkspaceMembers, useWorkspacePermissions } from "@/lib/workspace.ts";
import { workspaceSettingSection } from "@/lib/workspace-settings.ts";
import type { BackTarget } from "@/ui/settings-page.tsx";

/*
 * Where Back goes in settings: the page you came from, as a browser's Back
 * does, rather than a fixed parent. Each page is recorded against its place in
 * the browser's history, so Back is the browser's own Back and the two never
 * disagree, whether you press the link or the browser's button.
 *
 * A trail runs from where you entered settings (or the chat you came from)
 * to the page you are on. Every navigation begins a new one unless it says it
 * carries the trail on, so a link that forgets only loses the way back to where
 * you were, and never offers a way back to somewhere you chose to leave.
 */

/** A page the history reached, named by the route that drew it. */
interface VisitedPage {
	/** The history entry's own key, which a later page at the same index does not share. */
	key: string;
	href: string;
	routeId: string | undefined;
	params: Record<string, string>;
	/** The history index of the first page Back may return to from this one. */
	trailStart: number;
}

interface Trail {
	/** Each visited page by its index in the browser's history. */
	pages: ReadonlyMap<number, VisitedPage>;
	currentIndex: number;
	/** The history entry `pages` was last brought up to date with. */
	currentKey: string | undefined;
}

const CONTINUES_TRAIL = "continuesSettingsTrail";

/**
 * A navigation's history state that keeps the way back to the page it leaves,
 * for a link that goes deeper from where you are, such as a pod to one of its
 * bots or a chat to its bot's settings: `state={continueSettingsTrail}`.
 */
export function continueSettingsTrail(state: HistoryState): HistoryState {
	// Through a variable: `HistoryState` declares no fields, so a literal returned
	// as one is refused for the field it adds.
	const continuing = { ...state, [CONTINUES_TRAIL]: true };
	return continuing;
}

const SETTINGS_ROUTE = "/$workspace/settings";

function isSettingsRoute(routeId: string | undefined): boolean {
	return routeId === SETTINGS_ROUTE || routeId?.startsWith(`${SETTINGS_ROUTE}/`) === true;
}

const BackContext = createContext<BackTarget | undefined>(undefined);

/** Records every page the workspace shows, so settings pages can say where Back goes. */
export function SettingsTrailProvider({ children }: { children: ReactNode }) {
	const router = useRouter();
	const location = useLocation();
	const [trail, setTrail] = useState<Trail>(() => ({
		pages: new Map(),
		currentIndex: location.state.__TSR_index,
		currentKey: undefined,
	}));

	// Brought up to date while rendering, so the page a navigation lands on
	// never draws the Back of the page it left.
	const arrived = arrive(trail, router, location);
	if (arrived !== trail) setTrail(arrived);

	const previous = previousPage(trail);
	const label = usePageName(previous);
	const back = previous && label !== undefined ? backTo(previous.href, label, router) : undefined;

	return <BackContext value={back}>{children}</BackContext>;
}

/** A Back link to `href` that is the browser's own Back, so the page returned to is the history entry it was. */
function backTo(href: string, label: string, router: AnyRouter): BackTarget {
	return {
		label,
		render: (
			// biome-ignore lint/a11y/useAnchorContent: an element to render, which the Back link fills with its label.
			<a
				href={href}
				onClick={(event) => {
					// A click that opens a new tab or window follows the address instead.
					if (isPlainClick(event)) {
						event.preventDefault();
						router.history.back();
					}
				}}
			/>
		),
	};
}

/** The trail once `location` is reached, the same trail when it already stands there. */
function arrive(trail: Trail, router: AnyRouter, location: ParsedLocation): Trail {
	const key = location.state.__TSR_key ?? location.href;
	if (trail.currentKey === key) return trail;
	const [, params, route] = router.getMatchedRoutes(location.pathname);
	return record(trail, {
		key,
		index: location.state.__TSR_index,
		href: location.href,
		routeId: route?.id,
		params,
		continuesTrail: CONTINUES_TRAIL in location.state,
	});
}

function record(
	trail: Trail,
	arrival: {
		key: string;
		index: number;
		href: string;
		routeId: string | undefined;
		params: Record<string, string>;
		continuesTrail: boolean;
	},
): Trail {
	const { index } = arrival;
	const known = trail.pages.get(index);
	// Back or forward to a page already recorded: it is where it was.
	if (known?.key === arrival.key) {
		return { ...trail, currentIndex: index, currentKey: arrival.key };
	}
	const replacing = index === trail.currentIndex;
	const trailStart = !isSettingsRoute(arrival.routeId)
		? index
		: replacing
			? (known?.trailStart ?? index)
			: arrival.continuesTrail
				? (trail.pages.get(index - 1)?.trailStart ?? index)
				: index;
	// A new page at this index means anything recorded after it can no longer be reached.
	const pages = new Map([...trail.pages].filter(([at]) => at < index));
	pages.set(index, {
		key: arrival.key,
		href: arrival.href,
		routeId: arrival.routeId,
		params: arrival.params,
		trailStart,
	});
	return { pages, currentIndex: index, currentKey: arrival.key };
}

/** The page Back returns to from the current one, when that is a settings page with a trail behind it. */
function previousPage(trail: Trail): VisitedPage | undefined {
	const current = trail.pages.get(trail.currentIndex);
	const previousIndex = trail.currentIndex - 1;
	if (!current || !isSettingsRoute(current.routeId) || previousIndex < current.trailStart) {
		return undefined;
	}
	return trail.pages.get(previousIndex);
}

/** Back from the current settings page to the one you came from, if it can be named. */
export function useSettingsBack(): BackTarget | undefined {
	return useContext(BackContext);
}

/** Back to the page you came from, or to `parent`, the page this one sits under, when there is none. */
export function useBackTarget(parent: BackTarget): BackTarget {
	return useSettingsBack() ?? parent;
}

function isPlainClick(event: MouseEvent): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** What a visited page is called, as its Back link names it: the bot, the pod, the section. */
function usePageName(page: VisitedPage | undefined): string | undefined {
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id, {
		enabled: page?.params.member !== undefined,
	});
	const may = useWorkspacePermissions();
	const { data: providers } = useModelProviders({
		enabled: page?.params.provider !== undefined && may.manageProviders,
	});
	if (!page) return undefined;
	const { routeId, params } = page;
	if (routeId === SETTINGS_ROUTE) return "General";
	if (routeId === `${SETTINGS_ROUTE}/providers/system`) return "System agents";
	// A bot's chat is named as the place rather than the bot, which its settings are named after.
	if (!isSettingsRoute(routeId) && params.agent !== undefined) return "Chat";
	if (params.agent !== undefined && params.pod !== undefined) {
		const pod = findPod(pods, params.pod);
		return agents?.find((agent) => agent.podId === pod?.id && agent.handle === params.agent)?.name;
	}
	if (params.member !== undefined) {
		return members?.find((member) => member.id === params.member)?.user.name;
	}
	if (params.provider !== undefined) {
		return providers?.find((provider) => provider.id === params.provider)?.name;
	}
	if (params.pod !== undefined) {
		const pod = findPod(pods, params.pod);
		return pod && `${pod.name} pod`;
	}
	if (params.section !== undefined) return workspaceSettingSection(params.section)?.label;
	if (routeId?.startsWith("/$workspace/all")) return "All";
	return undefined;
}
