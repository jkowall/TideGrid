/**
 * Admin CLI for custom hostnames (G2.14b). See commands.ts.
 *
 *   DATABASE_URL=<admin url> pnpm --filter @tidegrid/hostnames-cli hostnames status demo-harbor
 */
import { createDb } from "@tidegrid/database";
import { parseArgs, runCommand, UsageError, usage } from "./commands.ts";

const url = process.env.DATABASE_URL;
let exitCode = 0;
try {
  const command = parseArgs(process.argv.slice(2));
  if (!url) throw new UsageError("DATABASE_URL (the admin connection) is required");
  const handle = createDb(url, { max: 1 });
  try {
    for (const line of await runCommand(handle.db, command, process.env)) console.log(line);
  } finally {
    await handle.end();
  }
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${usage}`);
    exitCode = 2;
  } else {
    // A database or provider error: its type and code only, never a token.
    const code = (error as { code?: unknown }).code;
    console.error(
      `${error instanceof Error ? error.name : "Error"}${typeof code === "string" ? ` ${code}` : ""}: ${error instanceof Error ? error.message : ""}`,
    );
    exitCode = 1;
  }
}
process.exit(exitCode);
