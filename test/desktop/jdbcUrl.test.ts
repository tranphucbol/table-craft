import { pluginUrl } from "@table-craft/desktop/main/import/jdbc.js";
import { describe, expect, it } from "vitest";

describe("pluginUrl", () => {
  it("givenJdbcPrefix_whenRead_thenDropped", () => {
    expect(pluginUrl("jdbc:postgresql://db:5432/shop")).toBe("postgresql://db:5432/shop");
  });

  it("givenOracleThinService_whenRead_thenOracleUrl", () => {
    expect(pluginUrl("jdbc:oracle:thin:@//oracle.internal:1521/FREEPDB1")).toBe(
      "oracle://oracle.internal:1521/FREEPDB1",
    );
    expect(pluginUrl("jdbc:oracle:thin:@oracle.internal:1521/FREEPDB1")).toBe("oracle://oracle.internal:1521/FREEPDB1");
    expect(pluginUrl("jdbc:oracle:thin:@db")).toBe("oracle://db");
  });

  it("givenOracleThinSid_whenRead_thenConnectBySid", () => {
    expect(pluginUrl("jdbc:oracle:thin:@db.internal:1521:ORCL")).toBe("oracle://db.internal:1521/ORCL?connect_by=sid");
  });

  it("givenOracleThinCredentials_whenRead_thenUserInfo", () => {
    expect(pluginUrl("jdbc:oracle:thin:scott/ti ger@//db:1521/PDB")).toBe("oracle://scott:ti%20ger@db:1521/PDB");
  });

  it("givenOracleDescriptor_whenRead_thenLeftAsWritten", () => {
    const descriptor = "oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521)))";
    expect(pluginUrl(`jdbc:${descriptor}`)).toBe(descriptor);
  });
});
