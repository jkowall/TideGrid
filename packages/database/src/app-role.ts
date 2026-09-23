/**
 * Set the runtime role's password. Run once per long-lived database (the Neon
 * main branch and staging) after migrations; branches copy it. Uses the admin
 * connection.
 *
 *   DATABASE_URL=... TIDEGRID_APP_PASSWORD=... tsx src/app-role.ts
 */
import { setRuntimeRolePassword } from "./role.ts";

const url = process.env.DATABASE_URL;
const password = process.env.TIDEGRID_APP_PASSWORD;
if (!url || !password) {
  console.error("DATABASE_URL and TIDEGRID_APP_PASSWORD are required.");
  process.exit(2);
}
try {
  await setRuntimeRolePassword(url, password);
  console.log("tidegrid_app password set");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
