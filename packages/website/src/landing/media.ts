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
	 * A 16:10 capture of the app, as WebP at 2240×1400: `/screenshots/main-chat.webp`.
	 * `bun run capture screenshots` makes them all; Computers needs the image from `bun run build:computer`.
	 */
	image?: string;
	/** What the screenshot should show, named on its placeholder until it exists. */
	shows: string;
}

export const screenshots: readonly [Screenshot, ...Screenshot[]] = [
	{
		title: "Channels",
		description:
			"Each project gets a channel, where people and bots share its main chat and threads, and reply and react the same way.",
		image: "/screenshots/main-chat.webp",
		shows: "A channel's main chat with two people and a bot",
	},
	{
		title: "Automations",
		description: "Scheduled work posts where the whole team sees it, not to one person’s inbox.",
		image: "/screenshots/automations.webp",
		shows: "Automations",
	},
	{
		title: "Computers",
		description: "Each bot runs code in its own isolated environment, never on your machine.",
		image: "/screenshots/computers.webp",
		shows: "The computer viewer",
	},
	{
		title: "Files",
		description: "What people upload and bots make is kept for the team, ready to open and review.",
		image: "/screenshots/files.webp",
		shows: "The files viewer",
	},
	{
		title: "Usage",
		description: "See what every bot, model and team costs, day by day.",
		image: "/screenshots/usage.webp",
		shows: "The Usage page",
	},
	{
		title: "Connect any MCP server",
		description:
			"Plug in Linear, Notion or anything else once for the whole team. Bots ask before each tool call, or run freely.",
		image: "/screenshots/mcp-connections.webp",
		shows: "A team’s connections to MCP servers",
	},
];
