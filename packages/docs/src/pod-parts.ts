/** The parts of a pod, as the docs' pod map explains them. */
export const podParts = {
	people: {
		label: "People",
		explanation:
			"Everyone added to the pod sees the same chats, results and approvals. Admins can reach every shared pod.",
	},
	bots: {
		label: "Bots",
		explanation:
			"Each bot lives in one pod, with its own instructions and model. Bots in a pod can ask each other for help.",
	},
	chats: {
		label: "Chats",
		explanation:
			"Every bot has one chat in its pod, shared by everyone in it. Talk to a bot there, together.",
	},
	connections: {
		label: "Connections",
		explanation:
			"Tools from apps like Linear or Notion, plugged in once for the whole pod. Every bot in it can use them, with your approval.",
	},
} as const;

export type PodPart = keyof typeof podParts;

/** The parts of a pod as a Markdown list, for readers who can't use the docs' interactive map. */
export function podPartsMarkdown(): string {
	return Object.values(podParts)
		.map(({ label, explanation }) => `- **${label}**: ${explanation}`)
		.join("\n");
}
