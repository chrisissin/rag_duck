import "dotenv/config";
import { spawn } from "node:child_process";

/**
 * Lightweight "cron" runner (in-process loop) that runs sync:once every N seconds.
 *
 * In production you'd usually:
 * - run `node src/indexer/sync_once.js` via system cron/k8s CronJob
 * - or run a queue/event-based indexer
 */
const interval = parseInt(process.env.SYNC_INTERVAL_SECONDS || "300", 10);

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/indexer/sync_once.js"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code));
  });
}

async function main() {
  console.log(`Starting sync cron loop. Interval=${interval}s`);
  while (true) {
    const code = await runOnce();
    if (code !== 0) {
      console.error(`sync_once exited with code ${code}`);
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
