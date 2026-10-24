/**
 * Vitest setup file in the headless box: points this worker, and every app it launches, at its own
 * virtual display (`entrypoint.sh` starts one per worker).
 */
import { displayFor, WORKERS_ENV } from "./workers.js";

const workers = Number(process.env[WORKERS_ENV]);
process.env["DISPLAY"] = displayFor(
  process.env["VITEST_POOL_ID"],
  Number.isInteger(workers) && workers >= 1 ? workers : 1,
);
