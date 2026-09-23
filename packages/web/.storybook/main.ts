import { fileURLToPath } from "node:url";
import { defineMain } from "@storybook/react-vite/node";

export default defineMain({
	framework: {
		name: "@storybook/react-vite",
		options: {
			builder: { viteConfigPath: fileURLToPath(new URL("./vite.config.ts", import.meta.url)) },
		},
	},
	stories: ["../src/**/*.stories.tsx"],
	staticDirs: ["./public"],
	addons: [
		"@storybook/addon-docs",
		"@storybook/addon-a11y",
		"@storybook/addon-vitest",
		"@storybook/addon-mcp",
		"msw-storybook-addon",
	],
	features: { componentsManifest: true },
	// TypeScript 7 no longer exposes the compiler API used by react-docgen-typescript.
	typescript: { reactDocgen: "react-docgen" },
});
