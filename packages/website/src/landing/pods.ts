import type { BotColor } from "@sugabots/avatars";

export interface Pod {
	name: string;
	description: string;
	tint: BotColor;
	bots: readonly BotColor[];
}

export const pods: readonly Pod[] = [
	{
		name: "Work",
		description: "Leads, bugs, the Monday report",
		tint: "green",
		bots: ["green", "cyan", "purple", "orange"],
	},
	{
		name: "Family",
		description: "Trips, birthdays, who's picking up Gran",
		tint: "sky",
		bots: ["sky", "yellow", "teal"],
	},
	{
		name: "Flat 4B",
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
];
