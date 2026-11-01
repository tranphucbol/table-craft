import { describe, expect, it } from "vitest";
import { recase } from "@table-craft/desktop/renderer/console/find/preserveCase.js";

describe("Preserve case", () => {
  it("givenUpperCaseMatch_whenRecased_thenReplacementUpperCase", () => {
    expect(recase("CUSTOMER", "client")).toBe("CLIENT");
  });

  it("givenLowerCaseMatch_whenRecased_thenReplacementLowerCase", () => {
    expect(recase("customer", "Client")).toBe("client");
  });

  it("givenCapitalisedMatch_whenRecased_thenReplacementCapitalised", () => {
    expect(recase("Customer", "cLIENT")).toBe("Client");
  });

  it("givenMixedCaseMatch_whenRecased_thenReplacementUnchanged", () => {
    expect(recase("cuSTomer", "Client")).toBe("Client");
    expect(recase("customerId", "client_id")).toBe("client_id");
  });

  it("givenMatchWithoutLetters_whenRecased_thenReplacementUnchanged", () => {
    expect(recase("42", "Answer")).toBe("Answer");
  });
});
