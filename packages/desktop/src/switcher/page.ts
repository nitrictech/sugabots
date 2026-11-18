import "@fontsource-variable/rubik";
import "../page.css";
import "./switcher.css";
import { element } from "../element.ts";
import type { SwitcherAccount, SwitcherBridge } from "./bridge.ts";

declare global {
	interface Window {
		readonly switcher: SwitcherBridge;
	}
}

/** How many places get a Ctrl/⌘+number shortcut, as in the Workspace menu. */
const SHORTCUT_COUNT = 9;
const IS_MAC = navigator.userAgent.includes("Mac");

/** A row of the list: a workspace, or an account with none to open, such as one signed out. */
interface Place {
	readonly id: string;
	readonly slug: string | undefined;
	readonly name: string;
	readonly tile: string;
	readonly open: boolean;
	/** The name, host and account, lowercased, which the filter matches. */
	readonly searchText: string;
	readonly shortcut: number | undefined;
}

interface AccountPlaces {
	readonly account: SwitcherAccount;
	readonly places: readonly Place[];
}

const filter = element("#filter", HTMLInputElement);
const list = element("#places", HTMLDivElement);
const empty = element("#empty", HTMLParagraphElement);

let groups: readonly AccountPlaces[] = [];
/** The places the filter leaves, in list order, which the arrow keys move through. */
let shown: Place[] = [];
let active = 0;

/** Every saved account's places, numbered across all of them in order, as the Workspace menu numbers them. */
function placesOf(accounts: readonly SwitcherAccount[]): AccountPlaces[] {
	let count = 0;
	const nextShortcut = () => (++count <= SHORTCUT_COUNT ? count : undefined);
	return accounts.map((account) => {
		const context = `${account.host} ${account.account ?? ""}`;
		if (account.workspaces.length === 0) {
			const name = account.account ? `Open ${account.host}` : "Sign in";
			const place: Place = {
				id: account.id,
				slug: undefined,
				name,
				tile: initial(account.host),
				open: account.open,
				searchText: `${name} ${context}`.toLowerCase(),
				shortcut: nextShortcut(),
			};
			return { account, places: [place] };
		}
		const places = account.workspaces.map(
			(workspace): Place => ({
				id: account.id,
				slug: workspace.slug,
				name: workspace.name,
				tile: initial(workspace.name),
				open: workspace.open,
				searchText: `${workspace.name} ${context}`.toLowerCase(),
				shortcut: nextShortcut(),
			}),
		);
		return { account, places };
	});
}

/**
 * Lists the places the filter matches, choosing the first match, or with no
 * filter the open one. With `keepActive`, the place chosen stays so while listed.
 */
function render({ keepActive }: { keepActive: boolean }): void {
	const query = filter.value.trim().toLowerCase();
	const previous = keepActive ? shown[active] : undefined;
	shown = [];
	list.replaceChildren(
		...groups.flatMap(({ account, places }) => {
			const matching = places.filter((place) => place.searchText.includes(query));
			return matching.length > 0 ? [groupElement(account, matching)] : [];
		}),
	);
	empty.hidden = shown.length > 0;
	const keptIndex = previous ? shown.findIndex((place) => samePlace(place, previous)) : -1;
	const openIndex = shown.findIndex((place) => place.open);
	setActive(keptIndex >= 0 ? keptIndex : query === "" ? Math.max(openIndex, 0) : 0);
}

function groupElement(account: SwitcherAccount, places: readonly Place[]): HTMLDivElement {
	const heading = document.createElement("div");
	heading.className = "group-heading";
	heading.id = `account-${account.id}`;
	heading.append(
		textElement("span", "host", account.host),
		textElement("span", "account", account.account ?? "Not signed in"),
	);
	const group = document.createElement("div");
	group.className = "group";
	group.setAttribute("role", "group");
	group.setAttribute("aria-labelledby", heading.id);
	group.append(heading, ...places.map(optionElement));
	return group;
}

function optionElement(place: Place): HTMLDivElement {
	const index = shown.push(place) - 1;
	const option = document.createElement("div");
	option.id = `place-${index}`;
	option.className = "place";
	option.setAttribute("role", "option");
	option.setAttribute("aria-selected", "false");
	const tile = textElement("span", "tile", place.tile);
	tile.style.setProperty("--hue", String(hue(`${place.id}/${place.slug ?? ""}`)));
	tile.setAttribute("aria-hidden", "true");
	option.append(tile, textElement("span", "name", place.name));
	if (place.open) option.append(textElement("span", "current", "Open"));
	if (place.shortcut !== undefined) {
		option.append(textElement("kbd", "", `${IS_MAC ? "⌘" : "Ctrl+"}${place.shortcut}`));
	}
	option.addEventListener("mousemove", () => setActive(index));
	option.addEventListener("click", () => void openPlace(place));
	return option;
}

function setActive(index: number): void {
	document.getElementById(`place-${active}`)?.setAttribute("aria-selected", "false");
	active = index;
	const option = document.getElementById(`place-${active}`);
	if (!option) {
		filter.removeAttribute("aria-activedescendant");
		return;
	}
	option.setAttribute("aria-selected", "true");
	option.scrollIntoView({ block: "nearest" });
	filter.setAttribute("aria-activedescendant", option.id);
}

async function openPlace(place: Place): Promise<void> {
	await window.switcher.open(place.id, place.slug);
}

function samePlace(one: Place, other: Place): boolean {
	return one.id === other.id && one.slug === other.slug;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text: string,
): HTMLElementTagNameMap[K] {
	const created = document.createElement(tag);
	if (className) created.className = className;
	created.textContent = text;
	return created;
}

function initial(text: string): string {
	return ([...text.trim()][0] ?? "?").toUpperCase();
}

/** A hue that stays the same for a place, so its tile keeps its colour between openings. */
function hue(key: string): number {
	let hash = 0;
	for (const character of key) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 360;
	return hash;
}

async function load(): Promise<void> {
	groups = placesOf(await window.switcher.accounts());
	render({ keepActive: true });
}

filter.addEventListener("input", () => render({ keepActive: false }));
filter.addEventListener("keydown", (event) => {
	const number = Number(event.key);
	if ((IS_MAC ? event.metaKey : event.ctrlKey) && number >= 1 && number <= SHORTCUT_COUNT) {
		const place = groups.flatMap(({ places }) => places).find((one) => one.shortcut === number);
		if (place) void openPlace(place);
		event.preventDefault();
		return;
	}
	switch (event.key) {
		case "ArrowDown":
			setActive(Math.min(active + 1, shown.length - 1));
			break;
		case "ArrowUp":
			setActive(Math.max(active - 1, 0));
			break;
		case "Enter": {
			const place = shown[active];
			if (place) void openPlace(place);
			break;
		}
		case "Escape":
			if (filter.value === "") {
				window.close();
				break;
			}
			filter.value = "";
			render({ keepActive: false });
			break;
		default:
			return;
	}
	event.preventDefault();
});
element("#add", HTMLButtonElement).addEventListener("click", () => {
	void window.switcher.addAccount();
});
window.switcher.onAccountsChanged(() => void load());

filter.focus();
void load();
