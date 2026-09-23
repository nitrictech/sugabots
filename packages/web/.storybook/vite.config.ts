import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config.ts";

export default mergeConfig(
	appConfig,
	defineConfig({
		define: {
			"import.meta.env.VITE_API_URL": JSON.stringify("https://api.storybook.test"),
		},
	}),
);
