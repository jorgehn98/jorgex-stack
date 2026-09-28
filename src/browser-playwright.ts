import { runManagedPlaywrightCommand } from "./lib/browser-command.js";

try {
  process.exitCode = runManagedPlaywrightCommand(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
