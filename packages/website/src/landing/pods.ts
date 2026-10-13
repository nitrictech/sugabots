import type { BotColor } from "@sugabots/avatars";

export interface Pod {
	name: string;
	description: string;
	tint: BotColor;
	bots: readonly BotColor[];
}

export const pods = [
	{
		name: "Work",
		description: "Leads, bugs, the Monday report",
		tint: "green",
		bots: ["green", "ice", "purple", "orange"],
	},
	{
		name: "Family",
		description: "Trips, birthdays, who's picking up Nan",
		tint: "sky",
		bots: ["sky", "yellow", "teal"],
	},
	{
		name: "Unit 4B",
		description: "Bills split fairly, bins on Tuesday",
		tint: "orange",
		bots: ["orange", "rose"],
	},
	{
		name: "Personal",
		description: "Notes, inbox, reminders, only seen by you",
		tint: "purple",
		bots: ["purple"],
	},
] as const satisfies readonly Pod[];

export type PodName = (typeof pods)[number]["name"];
