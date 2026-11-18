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

/** A workspace, or an account with none to open, such as one signed out. */
interface Place {
	readonly id: string;
	readonly slug: string | undefined;
	readonly name: string;
	/** Where it is: the host, and who it's signed in as. */
	readonly address: string;
	readonly open: boolean;
	/** The name and address, lowercased, which the filter matches. */
	readonly searchText: string;
	readonly shortcut: number | undefined;
}

/** A row of the list, which the arrow keys move through and Enter activates. */
interface Row {
	/** Tells a row apart across renders, so it stays chosen when the list refreshes. */
	readonly key: string;
	readonly open: boolean;
	readonly activate: () => void;
}

const filter = element("#filter", HTMLInputElement);
const list = element("#places", HTMLDivElement);
const empty = element("#empty", HTMLParagraphElement);

let places: readonly Place[] = [];
let rows: Row[] = [];
let active = 0;

/**
 * Every saved account's places, numbered in order, as the Workspace menu
 * numbers them. Their addresses name the account only where its server has
 * another saved, since the host alone tells the rest apart.
 */
function placesOf(accounts: readonly SwitcherAccount[]): Place[] {
	const hosts = accounts.map((account) => account.host);
	const sharedHosts = new Set(hosts.filter((host, index) => hosts.indexOf(host) !== index));
	let count = 0;
	const nextShortcut = () => (++count <= SHORTCUT_COUNT ? count : undefined);
	return accounts.flatMap((account): Place[] => {
		const named = sharedHosts.has(account.host) ? account.account : undefined;
		if (account.workspaces.length === 0) {
			const address = account.account ? (named ?? "No workspace yet") : "Not signed in";
			return [
				{
					id: account.id,
					slug: undefined,
					name: account.host,
					address,
					open: account.open,
					searchText: `${account.host} ${address}`.toLowerCase(),
					shortcut: nextShortcut(),
				},
			];
		}
		const address = named ? `${account.host} · ${named}` : account.host;
		return account.workspaces.map((workspace) => ({
			id: account.id,
			slug: workspace.slug,
			name: workspace.name,
			address,
			open: workspace.open,
			searchText: `${workspace.name} ${address}`.toLowerCase(),
			shortcut: nextShortcut(),
		}));
	});
}

/**
 * Lists the places the filter matches, then adding an account, choosing the
 * first match, or with no filter the open place. With `keepActive`, the row
 * chosen stays so while listed.
 */
function render({ keepActive }: { keepActive: boolean }): void {
	const query = filter.value.trim().toLowerCase();
	const previousKey = keepActive ? rows[active]?.key : undefined;
	const matching = places.filter((place) => place.searchText.includes(query));
	rows = [];
	list.replaceChildren(
		...matching.map((place) =>
			rowElement(
				{
					key: `${place.id}/${place.slug ?? ""}`,
					open: place.open,
					activate: () => void window.switcher.open(place.id, place.slug),
				},
				placeContent(place),
			),
		),
		rowElement(
			{ key: "add", open: false, activate: () => void window.switcher.addAccount() },
			addAccountContent(),
		),
	);
	empty.textContent = places.length === 0 ? "No accounts added yet." : "No workspace matches.";
	empty.hidden = matching.length > 0;
	const keptIndex = rows.findIndex((row) => row.key === previousKey);
	const openIndex = rows.findIndex((row) => row.open);
	setActive(keptIndex >= 0 ? keptIndex : query === "" ? Math.max(openIndex, 0) : 0);
}

function rowElement(row: Row, content: readonly Node[]): HTMLDivElement {
	const index = rows.push(row) - 1;
	const option = document.createElement("div");
	option.id = `row-${index}`;
	option.className = "row";
	option.setAttribute("role", "option");
	option.setAttribute("aria-selected", "false");
	option.append(...content);
	option.addEventListener("mousemove", () => setActive(index));
	option.addEventListener("click", row.activate);
	return option;
}

function placeContent(place: Place): Node[] {
	const tile = textElement("span", "tile", initial(place.name));
	tile.style.setProperty("--hue", String(hue(`${place.id}/${place.slug ?? ""}`)));
	tile.classList.toggle("open", place.open);
	tile.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.className = "text";
	text.append(
		textElement("span", "name", place.name),
		textElement("span", "address", place.address),
	);
	const content: Node[] = [tile, text];
	if (place.shortcut !== undefined) {
		content.push(textElement("kbd", "", `${IS_MAC ? "⌘" : "Ctrl "}${place.shortcut}`));
	}
	return content;
}

function addAccountContent(): Node[] {
	const tile = textElement("span", "tile add", "+");
	tile.setAttribute("aria-hidden", "true");
	return [tile, textElement("span", "text", "Add an account")];
}

function setActive(index: number): void {
	document.getElementById(`row-${active}`)?.setAttribute("aria-selected", "false");
	active = index;
	const option = document.getElementById(`row-${active}`);
	if (!option) {
		filter.removeAttribute("aria-activedescendant");
		return;
	}
	option.setAttribute("aria-selected", "true");
	option.scrollIntoView({ block: "nearest" });
	filter.setAttribute("aria-activedescendant", option.id);
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
	try {
		places = placesOf(await window.switcher.accounts());
	} catch (error) {
		// Such as a development build started before this page's preload existed, which leaves no bridge.
		empty.textContent = `Couldn't load your workspaces. ${error instanceof Error ? error.message : ""}`;
		empty.hidden = false;
		return;
	}
	render({ keepActive: true });
}

filter.addEventListener("input", () => render({ keepActive: false }));
filter.addEventListener("keydown", (event) => {
	const number = Number(event.key);
	if ((IS_MAC ? event.metaKey : event.ctrlKey) && number >= 1 && number <= SHORTCUT_COUNT) {
		const place = places.find((one) => one.shortcut === number);
		if (place) void window.switcher.open(place.id, place.slug);
		event.preventDefault();
		return;
	}
	switch (event.key) {
		case "ArrowDown":
			setActive(Math.min(active + 1, rows.length - 1));
			break;
		case "ArrowUp":
			setActive(Math.max(active - 1, 0));
			break;
		case "Enter":
			rows[active]?.activate();
			break;
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

filter.focus();
// Before anything else uses the bridge, so a page without one says so.
void load();
window.switcher.onAccountsChanged(() => void load());
