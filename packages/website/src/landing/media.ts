/**
 * The landing page's recorded material: the demo video under the hero and the
 * screenshots in the carousel. Files go in `public/`, so `/screenshots/x.png`
 * is `public/screenshots/x.png`. Each is captured once for each system's title
 * bar, and a path here names them all: `/screenshots/x.webp` is
 * `x-mac.webp`, `x-windows.webp` and `x-linux.webp`, of which a visitor sees
 * their own. Until a file is set, its frame shows a placeholder.
 */

/** The demo video, or until it exists, how long it will be. */
type DemoVideo = {
	/** How long the video runs, as `m:ss`, shown on the placeholder. */
	duration: string;
	/** A still for the frame before the video plays, at 16:9. */
	poster?: string;
	/** The video file, which has no sound. */
	src?: string;
};

/** Made by `bun run capture video`, which prints its length. */
export const demoVideo: DemoVideo = {
	duration: "0:59",
	src: "/demo/sugabots-demo.mp4",
	poster: "/demo/sugabots-demo-poster.webp",
};

export interface Screenshot {
	title: string;
	description: string;
	/**
	 * A 16:10 capture of the app, as WebP at 2240×1400: `/screenshots/project-chat.webp`.
	 * `bun run capture screenshots` makes them all; Computers needs the image from `bun run build:computer`.
	 */
	image?: string;
	/** What the screenshot should show, named on its placeholder until it exists. */
	shows: string;
}

export const screenshots: readonly [Screenshot, ...Screenshot[]] = [
	{
		title: "Projects",
		description:
			"Each piece of work gets a project, where people and bots share its chats, and reply and react the same way.",
		image: "/screenshots/project-chat.webp",
		shows: "A project's chat with two people and a bot",
	},
	{
		title: "Automations",
		description: "Automations run on routines or triggers, each run in a chat of the project.",
		image: "/screenshots/automations.webp",
		shows: "Automations",
	},
	{
		title: "Computers",
		description: "A project’s bots run code on its own computer, never on your machine.",
		image: "/screenshots/computers.webp",
		shows: "The computer viewer",
	},
	{
		title: "Files",
		description:
			"What people upload and bots make is kept in the project, ready to open and review.",
		image: "/screenshots/files.webp",
		shows: "The files viewer",
	},
	{
		title: "Usage",
		description: "See what every bot and model costs, day by day.",
		image: "/screenshots/usage.webp",
		shows: "The Usage page",
	},
	{
		title: "Connect any MCP server",
		description:
			"Connect a project to Linear, Notion or any MCP server; its bots use them in its chats. Bots ask before each tool call, or run freely.",
		image: "/screenshots/mcp-connectors.webp",
		shows: "A project’s connectors to MCP servers",
	},
];
