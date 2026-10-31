import { describe, expect, it } from "vitest";
import type { ServerSession, Session } from "@table-craft/plugin-api";
import { isListedAs, learnInstance, repeatedIds } from "@table-craft/desktop/engine/serverInstances.js";

const ID = "7";
const OWN = "10.0.0.1:10080";
const OTHER = "10.0.0.2:10080";

function row(id: string, instance: string | null): ServerSession {
  return {
    id,
    instance,
    state: "idle",
    rawState: "Sleep",
    user: null,
    database: null,
    client: null,
    application: null,
    queryMs: null,
    transactionMs: null,
    waitEvent: null,
    blockedBy: null,
    query: null,
    system: false,
    cancel: null,
    terminate: null,
  };
}

function session(fields: Partial<Session>): Session {
  return { serverSessionId: ID, serverVersion: null, close: () => Promise.resolve(), ...fields } as Session;
}

function counted(answer: () => Promise<string | null>): { session: Session; asked: () => number } {
  let asked = 0;
  const lookedUp = session({
    findServerInstance: () => {
      asked += 1;
      return answer();
    },
  });
  return { session: lookedUp, asked: () => asked };
}

describe("server instances", () => {
  it("givenIdOnTwoInstances_whenRepeatedIds_thenOnlyThatId", () => {
    expect([...repeatedIds([row(ID, OWN), row(ID, OTHER), row("8", OWN), row("9", null), row("9", null)])]).toEqual([
      ID,
    ]);
  });

  it("givenReportedInstance_whenListedAs_thenMatchesThatInstanceOnly", () => {
    const reported = session({ serverInstance: OWN });

    expect(isListedAs(reported, row(ID, OWN))).toBe(true);
    expect(isListedAs(reported, row(ID, OTHER))).toBe(false);
    expect(isListedAs(reported, row("8", OWN))).toBe(false);
  });

  it("givenNoInstance_whenListedAs_thenMatchesById", () => {
    const unknown = session({});

    expect(isListedAs(unknown, row(ID, OWN))).toBe(true);
    expect(isListedAs(unknown, row(ID, OTHER))).toBe(true);
  });

  it("givenRepeatedId_whenLearnTwice_thenAsksOnceAndMatchesItsInstance", async () => {
    const { session: lookedUp, asked } = counted(() => Promise.resolve(OWN));
    const repeated = new Set([ID]);

    const first = learnInstance(lookedUp, repeated);
    const second = learnInstance(lookedUp, repeated);
    await Promise.all([first, second]);
    await learnInstance(lookedUp, repeated);

    expect(asked()).toBe(1);
    expect(isListedAs(lookedUp, row(ID, OWN))).toBe(true);
    expect(isListedAs(lookedUp, row(ID, OTHER))).toBe(false);
  });

  it("givenLookupRejects_whenListedAs_thenMatchesByIdWithoutAskingAgain", async () => {
    const { session: failing, asked } = counted(() => Promise.reject(new Error("no answer")));
    const repeated = new Set([ID]);

    await learnInstance(failing, repeated);
    expect(learnInstance(failing, repeated)).toBeNull();

    expect(asked()).toBe(1);
    expect(isListedAs(failing, row(ID, OTHER))).toBe(true);
  });

  it("givenIdNotRepeated_whenLearn_thenNeverAsks", () => {
    const { session: lookedUp, asked } = counted(() => Promise.resolve(OWN));

    expect(learnInstance(lookedUp, new Set(["8"]))).toBeNull();
    expect(asked()).toBe(0);
  });
});
