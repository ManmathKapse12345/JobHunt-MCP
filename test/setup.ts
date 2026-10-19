// Runs inside every test file, before its tests.
import { afterAll } from "vitest";
import { closePools } from "../src/db/pool.js";
import { assertLocalDatabase } from "./env.js";

// Second check, in the process that actually opens connections.
assertLocalDatabase();

// Each test file gets its own copy of the modules (and pools); close them when it ends.
afterAll(async () => {
  await closePools();
});
