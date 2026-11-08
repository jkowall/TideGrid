/**
 * The email admin CLI (W3-G2.16-rest). See commands.ts.
 *
 *   DATABASE_URL=<admin url> pnpm --filter @tidegrid/email-cli email domain-status demo-harbor
 */
import { createDb } from "@tidegrid/database";
import { describeError, parseArgs, runCommand, UsageError, usage } from "./commands.ts";

const url = process.env.DATABASE_URL;
let exitCode = 0;
try {
  const command = parseArgs(process.argv.slice(2));
  if (!url) throw new UsageError("DATABASE_URL (the admin connection) is required");
  const handle = createDb(url, { max: 1 });
  try {
    for (const line of await runCommand(handle.db, command)) console.log(line);
  } finally {
    await handle.end();
  }
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${usage}`);
    exitCode = 2;
  } else {
    console.error(describeError(error));
    exitCode = 1;
  }
}
process.exit(exitCode);
