import { existsSync } from "node:fs";
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);

// Remotion's bundled chrome-headless-shell crashes on this Mac (its GPU process
// cannot load icudtl.dat), so render with the installed Chrome when there is one.
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (existsSync(chrome)) Config.setBrowserExecutable(chrome);
