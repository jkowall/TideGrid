/**
 * The reviewed replay command for outbox dead letters (W3-G2.3).
 *
 *   pnpm --filter @tidegrid/database outbox:dlq list
 *   pnpm --filter @tidegrid/database outbox:dlq replay --tenant <uuid> --id <dead letter id> \
 *     --operator <name> --reason "<why it is safe to run again>" [--go]
 *
 * It connects with DATABASE_URL, the runtime role's connection, and reads and
 * writes only through tenant transactions. `list` prints one JSON line per
 * open dead letter: ids, topic, handler, error code, attempts, and source,
 * never a payload. `replay` without --go prints the dead letter it would
 * replay and changes nothing; with --go it closes the dead letter with the
 * reason (an audit row records it) and makes the event due again, so only the
 * handlers with no outcome run. Review the failing handler's fix before --go.
 */
import {
  getOpenDeadLetter,
  listDeadLetters,
  ReplayRefusedError,
  replayDeadLetter,
} from "./delivery.ts";
import { createDb } from "./index.ts";
import { isUuid } from "./tenant.ts";

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: readonly string[], out: (line: string) => void = console.log) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const command = argv[0];
  const handle = createDb(url, { max: 1 });
  try {
    if (command === "list") {
      const rows = await listDeadLetters(handle.db);
      for (const r of rows)
        out(JSON.stringify({ ...r, deadLetteredAt: r.deadLetteredAt.toISOString() }));
      out(JSON.stringify({ open: rows.length }));
      return 0;
    }
    if (command === "replay") {
      const tenantId = arg(argv, "--tenant");
      const id = arg(argv, "--id");
      const operator = arg(argv, "--operator");
      const reason = arg(argv, "--reason");
      if (
        !isUuid(tenantId) ||
        !id ||
        !operator ||
        !/^[A-Za-z0-9_.@-]{1,100}$/.test(operator) ||
        !reason
      ) {
        out(
          "usage: outbox:dlq replay --tenant <uuid> --id <id> --operator <name> --reason <text> [--go]",
        );
        return 2;
      }
      const ctx = {
        tenantId,
        actorType: "support" as const,
        actorId: operator,
        requestId: `outbox-replay-${Date.now()}`,
      };
      const open = await getOpenDeadLetter(handle.db, ctx, id);
      if (!open) {
        out(JSON.stringify({ refused: "not_found_or_already_replayed" }));
        return 1;
      }
      out(
        JSON.stringify({
          wouldReplay: { ...open, deadLetteredAt: open.deadLetteredAt.toISOString() },
        }),
      );
      if (!argv.includes("--go")) {
        out(JSON.stringify({ dryRun: true, next: "add --go to replay" }));
        return 0;
      }
      try {
        const done = await replayDeadLetter(handle.db, ctx, { deadLetterId: id, reason });
        out(JSON.stringify({ replayed: true, ...done }));
        return 0;
      } catch (error) {
        if (error instanceof ReplayRefusedError) {
          out(JSON.stringify({ refused: error.code }));
          return 1;
        }
        throw error;
      }
    }
    out("usage: outbox:dlq list | replay ...");
    return 2;
  } finally {
    await handle.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.name : "error");
      process.exit(1);
    },
  );
}
