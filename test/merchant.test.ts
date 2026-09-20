import { describe, expect, it } from "vitest";
import { canonicalMerchantKey, normalizeMerchant } from "../src/lib/merchant";

describe("normalizeMerchant", () => {
  it("collapses store-number variants of the same chain", () => {
    expect(normalizeMerchant("WALMART #4821 GRAND JCT CO")).toBe("WALMART");
    expect(normalizeMerchant("WALMART #0193 DENVER CO")).toBe("WALMART");
  });

  it("strips card-network / processor prefixes", () => {
    expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE")).toBe("BLUE BOTTLE COFFEE");
    expect(normalizeMerchant("TST* THE HIVE MERCANTILE")).toBe("THE HIVE MERCANTILE");
  });

  it("is case-insensitive and trims whitespace noise", () => {
    expect(normalizeMerchant("  starbucks   #1234 denver co ")).toBe("STARBUCKS");
  });
});

describe("canonicalMerchantKey", () => {
  it("drops per-charge reference tokens but keeps product names after '*'", () => {
    expect(canonicalMerchantKey("AMAZON PRIME*2K4L9 AMZN.COM/BILL WA")).toBe(canonicalMerchantKey("AMAZON PRIME*7HH3Q AMZN.COM/BILL WA"));
    expect(canonicalMerchantKey("AMAZON PRIME*2K4L9 AMZN.COM/BILL WA").startsWith("AMAZON PRIME")).toBe(true);
    expect(canonicalMerchantKey("GOOGLE *YouTubePremium")).toBe("GOOGLE YOUTUBEPREMIUM");
  });

  it("drops leading date stamps, phone numbers, web suffixes and filler", () => {
    expect(canonicalMerchantKey("CHECKCARD 0815 NETFLIX.COM")).toBe("NETFLIX");
    expect(canonicalMerchantKey("NETFLIX.COM 866-579-7172 CA")).toBe("NETFLIX");
    expect(canonicalMerchantKey("Netflix")).toBe("NETFLIX");
    expect(canonicalMerchantKey("SPOTIFY USA 8887784875 NY")).toBe("SPOTIFY");
    expect(canonicalMerchantKey("ROCKY MTN POWER BILL PAY")).toBe("ROCKY MTN POWER");
    expect(canonicalMerchantKey("ACH DEBIT MORTGAGE 000123")).toBe("MORTGAGE");
  });

  it("never collapses to nothing", () => {
    expect(canonicalMerchantKey("BILL PAY")).not.toBe("");
  });
});
