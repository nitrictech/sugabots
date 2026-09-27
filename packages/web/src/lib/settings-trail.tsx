import type { useRender } from "@base-ui/react/use-render";
import { type HistoryState, useLocation, useRouter } from "@tanstack/react-router";
import { createContext, type MouseEvent, type ReactNode, useContext, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useWorkspace, useWorkspaceMembers, useWorkspacePermissions } from "@/lib/workspace.ts";
import { workspaceSettingSection } from "@/lib/workspace-settings.ts";

/*
 * Where Back goes in settings: the page you came from, as a browser's Back
 * does, rather than a fixed parent. Each page is recorded against its place in
 * the browser's history, so Back is the browser's own Back and the two never
 * disagree, whether you press the link or the browser's button.
 *
 * A trail runs from where you entered settings (or the chat you came from)
 * to the page you are on. Picking a section from the settings navigation
 * begins a new one, so Back does not walk you through steps you chose to
 * leave behind.
 */

/** A page the history reached, named by the route that drew it. */
interface VisitedPage {
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

const STARTS_TRAIL = "startsSettingsTrail";

/**
 * A navigation's history state that begins a new trail, for a link or
 * `navigate` that is a deliberate choice of where to be: `state={startSettingsTrail}`.
 */
export function startSettingsTrail(state: HistoryState): HistoryState {
	const next = { ...state, [STARTS_TRAIL]: true };
	return next;
}

const SETTINGS_ROUTE = "/$workspace/settings";

function isSettingsRoute(routeId: string | undefined): boolean {
	return routeId === SETTINGS_ROUTE || routeId?.startsWith(`${SETTINGS_ROUTE}/`) === true;
}

const TrailContext = createContext<Trail | undefined>(undefined);

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
	const key = location.state.__TSR_key ?? location.href;
	if (trail.currentKey !== key) {
		const [, params, route] = router.getMatchedRoutes(location.pathname);
		setTrail(
			record(trail, {
				key,
				index: location.state.__TSR_index,
				href: location.href,
				routeId: route?.id,
				params,
				startsTrail: STARTS_TRAIL in location.state,
			}),
		);
	}

	return <TrailContext value={trail}>{children}</TrailContext>;
}

function record(
	trail: Trail,
	arrival: {
		key: string;
		index: number;
		href: string;
		routeId: string | undefined;
		params: Record<string, string>;
		startsTrail: boolean;
	},
): Trail {
	const { index } = arrival;
	const known = trail.pages.get(index);
	// Back or forward to a page already recorded: it is where it was.
	if (known?.href === arrival.href) {
		return { ...trail, currentIndex: index, currentKey: arrival.key };
	}
	const replacing = index === trail.currentIndex;
	const trailStart =
		arrival.startsTrail || !isSettingsRoute(arrival.routeId)
			? index
			: replacing
				? (known?.trailStart ?? index)
				: (trail.pages.get(index - 1)?.trailStart ?? index);
	// A new page at this index means anything recorded after it can no longer be reached.
	const pages = new Map([...trail.pages].filter(([at]) => at < index));
	pages.set(index, {
		href: arrival.href,
		routeId: arrival.routeId,
		params: arrival.params,
		trailStart,
	});
	return { pages, currentIndex: index, currentKey: arrival.key };
}

/** Where a Back link goes and what it says, as the element it renders: `render={<Link … />}`. */
export interface BackTarget {
	label: string;
	render: useRender.RenderProp;
}

/** Back from the current settings page to the one you came from, if it can be named. */
export function useSettingsBack(): BackTarget | undefined {
	const router = useRouter();
	const trail = useContext(TrailContext);
	const current = trail?.pages.get(trail.currentIndex);
	const previousIndex = (trail?.currentIndex ?? 0) - 1;
	const previous =
		current && isSettingsRoute(current.routeId) && previousIndex >= current.trailStart
			? trail?.pages.get(previousIndex)
			: undefined;
	const label = usePageName(previous);
	if (!previous || label === undefined) return undefined;
	return {
		label,
		render: (
			// biome-ignore lint/a11y/useAnchorContent: an element to render, which the Back link fills with its label.
			<a
				href={previous.href}
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
	const { data: members } = useWorkspaceMembers(workspace?.id);
	const may = useWorkspacePermissions();
	const { data: providers } = useModelProviders(
		page?.params.provider !== undefined && may.manageProviders,
	);
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
