/**
 * Set the runtime role's password. Run once per long-lived database (the Neon
 * main branch and staging) after migrations; branches copy it. Uses the admin
 * connection.
 *
 *   DATABASE_URL=... TIDEGRID_APP_PASSWORD=... tsx src/app-role.ts [--neon-main]
 *
 * It refuses Neon main unless --neon-main is given: a new password breaks
 * Hyperdrive until its config and the DATABASE_URL secret carry it (release
 * runbook rule 4). See the Neon main guard in the package README.
 */
import { fileURLToPath } from "node:url";
import { setRuntimeRolePassword } from "./role.ts";
import { neonMainRefusal } from "./testing.ts";

const usage = "usage: app-role.ts [--neon-main]";

/** Parse the command's flags. Exported for the unit test. */
export function parseAppRoleArgs(args: readonly string[]): { neonMain: boolean } {
  let neonMain = false;
  for (const arg of args) {
    if (arg === "--neon-main") neonMain = true;
    // pnpm can pass the separator through.
    else if (arg !== "--") throw new Error(`unknown argument; ${usage}`);
  }
  return { neonMain };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let neonMain: boolean;
  try {
    ({ neonMain } = parseAppRoleArgs(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  const password = process.env.TIDEGRID_APP_PASSWORD;
  if (!url || !password) {
    console.error("DATABASE_URL and TIDEGRID_APP_PASSWORD are required.");
    process.exit(2);
  }
  const refusal = neonMainRefusal(url, { appRole: { neonMain } });
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  try {
    await setRuntimeRolePassword(url, password);
    console.log("tidegrid_app password set");
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
