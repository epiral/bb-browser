import { getRuntimePackageVersion } from "./runtime-version.js";

declare const __BB_BROWSER_VERSION__: string;

export const CLI_VERSION = getRuntimePackageVersion(import.meta.url, __BB_BROWSER_VERSION__);
