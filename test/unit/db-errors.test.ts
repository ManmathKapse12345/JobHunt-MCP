import { describe, expect, it } from "vitest";
import { isDbUnavailable } from "../../src/db/errors.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("isDbUnavailable", () => {
  it.each([
    ["refused", withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")],
    ["DNS failure", withCode("getaddrinfo ENOTFOUND db.example.com", "ENOTFOUND")],
    ["reset", withCode("read ECONNRESET", "ECONNRESET")],
    ["pg connection exception (class 08)", withCode("connection failure", "08006")],
    ["server shutting down", withCode("terminating connection due to administrator command", "57P01")],
    ["too many connections", withCode("sorry, too many clients already", "53300")],
    ["pool connect timeout", new Error("timeout exceeded when trying to connect")],
    ["connection dropped", new Error("Connection terminated unexpectedly")],
    ["query timeout", new Error("Query read timeout")],
    [
      "localhost: both ::1 and 127.0.0.1 refused",
      new AggregateError([withCode("connect ECONNREFUSED ::1:5432", "ECONNREFUSED"), withCode("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED")]),
    ],
  ])("yes: %s", (_name, err) => {
    expect(isDbUnavailable(err)).toBe(true);
  });

  it.each([
    ["a bug", new TypeError("Cannot read properties of undefined")],
    ["bad SQL", withCode('relation "nope" does not exist', "42P01")],
    ["a constraint", withCode("duplicate key value violates unique constraint", "23505")],
    ["wrong password (retrying won't help)", withCode("password authentication failed", "28P01")],
    ["not an Error", "ECONNREFUSED"],
    ["an empty AggregateError", new AggregateError([])],
  ])("no: %s", (_name, err) => {
    expect(isDbUnavailable(err)).toBe(false);
  });
});
