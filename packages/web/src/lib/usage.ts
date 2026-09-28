import { DEFAULT_TIME_ZONE, timeZoneSchema, type UsageMonth } from "@sugabots/contracts";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Effect, Schema } from "effect";
import { client } from "@/api.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/** What the workspace's models cost over `month`, with the month and its days in the workspace's time zone. */
export function useWorkspaceUsage(month: UsageMonth | undefined) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["usage", workspaceId, month],
		queryFn:
			workspaceId && month
				? ({ signal }) =>
						Effect.runPromise(
							client.api.usage.month({
								params: { workspace: workspaceId },
								query: { month },
							}),
							{ signal },
						)
				: skipToken,
	});
}

/**
 * `timeZone`, or UTC when this browser doesn't have it: which zones exist
 * depends on the browser's version. The server works out every day and month
 * in the workspace's own zone, so falling back only moves which month is this
 * one and which day is today, and by a day at most.
 */
export function timeZoneOrUtc(timeZone: string): string {
	return Schema.is(timeZoneSchema)(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

/** `YYYY-MM-DD` for `at` in `timeZone`. */
export function dateIn(at: Date, timeZone: string): string {
	// Canada writes dates the ISO way round.
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(at);
}

/** The month `at` falls in, in `timeZone`. */
export function monthIn(at: Date, timeZone: string): UsageMonth {
	return dateIn(at, timeZone).slice(0, 7);
}

/** The month `by` months after `month`, or before it for a negative `by`. */
export function shiftMonth(month: UsageMonth, by: number): UsageMonth {
	const [year = 0, monthNumber = 1] = month.split("-").map(Number);
	const index = year * 12 + (monthNumber - 1) + by;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** "Sep": the three-letter month the design uses, which British English writes as "Sept". */
const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const longMonth = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

const firstOf = (month: UsageMonth) => new Date(`${month}-01T00:00:00Z`);

/** "Sep 2026". */
export function monthLabel(month: UsageMonth): string {
	return `${shortMonth.format(firstOf(month))} ${month.slice(0, 4)}`;
}

/** "September 2026", for what is read out rather than shown. */
export function longMonthLabel(month: UsageMonth): string {
	return `${longMonth.format(firstOf(month))} ${month.slice(0, 4)}`;
}

/** "1 Sep", for a `YYYY-MM-DD` date. */
export function dayLabel(date: string): string {
	return `${Number(date.slice(8, 10))} ${shortMonth.format(firstOf(date.slice(0, 7)))}`;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The smallest amount written as cents rather than as "less than a cent". */
const ONE_CENT = 0.01;

/**
 * "$94.20". An amount under a cent reads "<$0.01" rather than "$0.00", which
 * is kept for what cost nothing at all.
 */
export function formatUsd(usd: number): string {
	return usd > 0 && usd < ONE_CENT / 2 ? `<${dollars.format(ONE_CENT)}` : dollars.format(usd);
}
