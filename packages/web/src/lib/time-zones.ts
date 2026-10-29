import { DEFAULT_TIME_ZONE, type TimeZone } from "@sugabots/contracts";

/** A time zone as a list of them shows it. */
export interface TimeZoneChoice {
	readonly zone: TimeZone;
	/** Where it is, as people name it: "Buenos Aires", or "UTC". */
	readonly place: string;
	/** How far it is from UTC now, such as "UTC+11", or "UTC" itself. */
	readonly offset: string;
}

/**
 * Every time zone this browser knows, by name. Routines run only in these,
 * so a workspace moved to one can keep its schedules.
 */
export function timeZoneChoices(now: Date): TimeZoneChoice[] {
	const zones = Intl.supportedValuesOf("timeZone");
	const named = zones.includes(DEFAULT_TIME_ZONE) ? zones : [DEFAULT_TIME_ZONE, ...zones];
	return named.map((zone) => timeZoneChoice(zone, now));
}

export function timeZoneChoice(zone: TimeZone, now: Date): TimeZoneChoice {
	return { zone, place: timeZonePlace(zone), offset: utcOffset(zone, now) };
}

/** Zones grouped by where in the world they are, as a list of them is browsed. */
export interface TimeZoneRegion {
	readonly name: string;
	/** Its zones, by place. */
	readonly choices: readonly TimeZoneChoice[];
}

/** The regions a zone's first part names, as people call them, in the order they are listed. */
const NAMED_REGIONS: readonly (readonly [prefix: string, name: string])[] = [
	["Africa", "Africa"],
	["America", "Americas"],
	["Asia", "Asia"],
	["Australia", "Australia"],
	["Europe", "Europe"],
	["Pacific", "Pacific"],
];

/** Where every zone with too few neighbours for a region of its own goes: UTC, the oceans, the poles. */
const OTHER_REGION = "Other";

/** `choices` by region, each region's by place, and the zones of no named region last, as Other. */
export function timeZoneRegions(choices: readonly TimeZoneChoice[]): TimeZoneRegion[] {
	const byPlace = [...choices].sort((one, other) => one.place.localeCompare(other.place));
	const regions = NAMED_REGIONS.map(([prefix, name]) => ({
		name,
		choices: byPlace.filter((choice) => choice.zone.startsWith(`${prefix}/`)),
	}));
	const named = new Set(regions.flatMap((region) => region.choices));
	const others = byPlace.filter((choice) => !named.has(choice));
	return [...regions, { name: OTHER_REGION, choices: others }].filter(
		(region) => region.choices.length > 0,
	);
}

/** The place a zone is named for: its last part, "Los Angeles" for America/Los_Angeles. */
export function timeZonePlace(zone: string): string {
	return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

function utcOffset(zone: string, now: Date): string {
	const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
		.formatToParts(now)
		.find((part) => part.type === "timeZoneName")?.value;
	return offset ? offset.replace("GMT", "UTC") : "";
}
