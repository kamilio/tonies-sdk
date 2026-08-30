#!/usr/bin/env node
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { runCLI } from "toolcraft/cli";
import { root } from "./root.js";

export async function cli(args: string[]): Promise<void> {
  await runCLI(root, {
    argv: [process.argv[0], process.argv[1], ...args],
    rootUsageName: "tonies",
    version: "0.1.0",
    presets: true,
    controls: { debug: true, verbose: true, logLevel: true }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli(process.argv.slice(2));
}
