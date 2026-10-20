import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Sugabots",
		identifier: "io.nitric.sugabots.desktop",
		version: "0.0.0-dev",
	},
	runtime: {
		// The app stays in the tray when its windows close; the tray's Quit ends it.
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			setup: { entrypoint: "src/setup/index.ts" },
			approve: { entrypoint: "src/approve/index.ts" },
		},
		copy: {
			"src/setup/index.html": "views/setup/index.html",
			"src/setup/index.css": "views/setup/index.css",
			"src/approve/index.html": "views/approve/index.html",
			"src/approve/index.css": "views/approve/index.css",
			"src/shared/base.css": "views/assets/base.css",
			"../avatars/assets/sugabots-logo.svg": "views/assets/sugabots-logo.svg",
			"node_modules/@fontsource-variable/rubik/files/rubik-latin-wght-normal.woff2":
				"views/assets/rubik.woff2",
		},
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
