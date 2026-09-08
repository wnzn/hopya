import { mergeConfig } from "astro/config";
import config from "./astro.config.mjs";

// Browser contracts must not overwrite a running preview's optimized React modules.
const cache = `./node_modules/.cache/hopya-browser-${process.env.HOPYA_BROWSER_PORT || 4321}`;
export default mergeConfig(config, {
  cacheDir: `${cache}/astro`,
  vite: { cacheDir: `${cache}/vite` },
});
