import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: { rolldownOptions: { input: { main: "src/main.ts" } } },
	},
	preload: {
		build: {
			rolldownOptions: {
				input: { "setup-preload": "src/setup/preload.ts" },
				// Electron runs a sandboxed preload as a classic script, never as an ES module.
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: "src/setup",
		build: { rolldownOptions: { input: resolve(import.meta.dirname, "src/setup/page.html") } },
	},
});
