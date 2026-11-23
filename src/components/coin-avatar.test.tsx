import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COINS, CoinAvatar, coinLogoSrc } from "./coin-avatar";

const files = readdirSync(resolve(__dirname, "../../public/coins")).filter((f) =>
  f.endsWith(".svg"),
);

describe("coinLogoSrc", () => {
  it("serves a known coin from the same origin, whatever its case", () => {
    expect(coinLogoSrc("BTC")).toBe("/coins/btc.svg");
    expect(coinLogoSrc(" ethx ")).toBe("/coins/ethx.svg");
  });

  it("gives wrapped and staked tokens without a logo their base coin's", () => {
    expect(coinLogoSrc("stETH")).toBe("/coins/eth.svg");
    expect(coinLogoSrc("WETH")).toBe("/coins/eth.svg");
  });

  it("has no logo for a coin we do not ship", () => {
    expect(coinLogoSrc("NOTACOIN")).toBeNull();
  });

  it("lists exactly the files in public/coins", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) expect(coinLogoSrc(f.replace(".svg", ""))).toBe(`/coins/${f}`);
    expect([...COINS].map((c) => `${c.toLowerCase()}.svg`).sort()).toEqual([...files].sort());
    expect(coinLogoSrc("RENDER")).toBe("/coins/rndr.svg");
  });
});

describe("CoinAvatar", () => {
  it("shows the logo for a known coin", () => {
    const { container } = render(<CoinAvatar symbol="BTC" color="#f7931a" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/coins/btc.svg");
    expect(screen.queryByTestId("coin-letter")).toBeNull();
  });

  it("shows the first letter in the coin's colour for an unknown coin", () => {
    render(<CoinAvatar symbol="zzz" color="#0ea5e9" />);
    const letter = screen.getByTestId("coin-letter");
    expect(letter.textContent).toBe("Z");
    expect(letter.style.color).toBe("rgb(14, 165, 233)");
  });

  it("falls back to the letter when the logo fails to load", () => {
    const { container } = render(<CoinAvatar symbol="ETH" color={undefined} />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByTestId("coin-letter").textContent).toBe("E");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows ? for an empty symbol", () => {
    render(<CoinAvatar symbol="  " color={undefined} />);
    expect(screen.getByTestId("coin-letter").textContent).toBe("?");
  });
});
