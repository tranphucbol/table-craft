import type { Client } from "./connect.js";
import type { RunningOn } from "./routing.js";

/** What a command `CLIENT UNBLOCK … ERROR` stopped fails with, which the session reports as `cancelled`. */
export const UNBLOCKED = /^UNBLOCKED /;

export const CANCELLED_MESSAGE = "Cancelled: CLIENT UNBLOCK stopped the blocking command.";

/**
 * Stops the console's blocking commands from a short-lived second connection to each node they
 * run on (decision 22 of plan 058). Redis runs one command at a time, so a command that does not
 * block is left to finish.
 */
export async function unblock(
  open: (address: string) => Promise<Client>,
  running: readonly RunningOn[],
): Promise<void> {
  await Promise.all(
    running.map(async ({ address, clientId }) => {
      const client = await open(address);
      try {
        await client.sendCommand(["CLIENT", "UNBLOCK", clientId, "ERROR"]);
      } finally {
        client.destroy();
      }
    }),
  );
}
