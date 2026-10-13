const website = "https://sugabots.ai";
const repository = "https://github.com/nitrictech/sugabots";

/**
 * Where Sugabots lives on the web. The app and the website both link to these,
 * so an address changed here changes everywhere it is shown.
 */
export const projectLinks = {
	website,
	documentation: `${website}/docs`,
	/** The website redirects this to the current invite, so links outlive any one invite. */
	discord: `${website}/discord`,
	repository,
	releases: `${repository}/releases`,
} as const;
