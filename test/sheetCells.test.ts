import { describe, expect, it } from "vitest";
import { normalize, parseDate, parseMoneyCents, parseMonth } from "../src/sheets/cells";
import { parseSpreadsheetId } from "../src/sheets/client";
import { parseServiceAccountKey, signServiceAccountJwt } from "../src/sheets/googleAuth";
import { parseSplit } from "../src/sheets/tabs/transactions";

describe("cell normalization — a cosmetic difference is not an edit", () => {
  it("treats the ways Sheets shows money as the same amount", () => {
    for (const v of [120, "120", "$120.00", "120.0", " $120 "]) expect(normalize("money", v)).toBe("12000");
    expect(parseMoneyCents("(45.10)")).toBe(-4510);
    expect(parseMoneyCents("-$1,200.50")).toBe(-120050);
    expect(parseMoneyCents("abc")).toBeNull();
    expect(normalize("money", null)).toBe(normalize("money", ""));
  });

  it("reads typed dates and month cells", () => {
    expect(parseDate("10/5/2026")).toBe("2026-10-05");
    expect(parseDate("2026-10-05")).toBe("2026-10-05");
    expect(parseDate("2/30/2026")).toBeNull();
    expect(parseDate(46300)).toMatch(/^20\d\d-\d\d-\d\d$/);
    expect(parseMonth("2026-11")).toBe("2026-11");
    expect(parseMonth("Nov 2026")).toBe("2026-11");
    expect(parseMonth("2026-11-01")).toBe("2026-11");
    expect(parseMonth("next month")).toBeNull();
  });

  it("compares tags and choices without caring about order or case", () => {
    expect(normalize("tags", "Vacation, reimbursable")).toBe(normalize("tags", "reimbursable,vacation"));
    expect(normalize("choice", "Reset")).toBe("reset");
    expect(normalize("bool", null)).toBe("false");
    expect(normalize("bool", "TRUE")).toBe("true");
  });

  it("reads a Split cell", () => {
    expect(parseSplit("Groceries 120, Household 60.50")).toEqual([
      { category: "Groceries", dollars: 120 },
      { category: "Household", dollars: 60.5 },
    ]);
    expect(parseSplit("Kids' clothes: $40; Gifts = 20")).toEqual([
      { category: "Kids' clothes", dollars: 40 },
      { category: "Gifts", dollars: 20 },
    ]);
    expect(() => parseSplit("just groceries")).toThrow(/Category amount/);
  });

  it("pulls the spreadsheet id out of a link", () => {
    expect(parseSpreadsheetId("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    );
    expect(parseSpreadsheetId("not a link")).toBeNull();
  });
});

describe("service-account JWT", () => {
  it("signs an assertion Google can verify with the account's public key", async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let binary = "";
    for (const b of pkcs8) binary += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const key = parseServiceAccountKey(JSON.stringify({ client_email: "budget@project.iam.gserviceaccount.com", private_key: pem }));

    const jwt = await signServiceAccountJwt(key, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");
    const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, decode(signature!), new TextEncoder().encode(`${header}.${claims}`));
    expect(ok).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(decode(claims!)))).toMatchObject({
      iss: "budget@project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/spreadsheets",
      exp: 1_800_003_600,
    });
  });

  it("explains a bad key instead of failing obscurely", () => {
    expect(() => parseServiceAccountKey(undefined)).toThrow(/GOOGLE_SERVICE_ACCOUNT_JSON/);
    expect(() => parseServiceAccountKey("{}")).toThrow(/client_email/);
  });
});
