// Real coin logos, served from /public/coins (same origin, no third-party request, so holdings stay
// private). The files are web3icons' "background" token icons (MIT, github.com/0xa3k5/web3icons):
// a white glyph on the brand colour, clipped to a circle here. Coins without a file show their
// first letter in the coin's allocation colour.
import { useState } from "react";

// prettier-ignore
export const COINS: ReadonlySet<string> = new Set([
  "AAVE", "ADA", "ALGO", "APT", "ARB", "ATOM", "AVAX", "AXS", "BCH", "BNB", "BTC", "CAKE", "CBETH", "COMP", "CRO", "CRV", "DAI", "DASH", "DOGE", "DOT", "EGLD", "EOS", "ETC", "ETH", "ETHX", "EURC", "EURT", "FDUSD", "FET", "FIL", "FLOW", "FTM", "GRT", "HBAR", "ICP", "IMX", "JUP", "KAS", "KSM", "LDO", "LEO", "LINK", "LTC", "MANA", "MATIC", "MINA", "MKR", "NEAR", "OP", "PAXG", "PEPE", "POL", "PYTH", "PYUSD", "QNT", "RETH", "RNDR", "RUNE", "SAND", "SEI", "SHIB", "SNX", "SOL", "STX", "SUI", "TAO", "TIA", "TRX", "UNI", "USDC", "USDE", "USDT", "VET", "WBTC", "XAUT", "XLM", "XMR", "XRP", "XTZ", "ZEC",
]);

// Wrapped and liquid-staking tokens with no logo of their own wear their base coin's.
const SAME_LOGO_AS: Record<string, string> = {
  STETH: "ETH",
  WSTETH: "ETH",
  WETH: "ETH",
  RENDER: "RNDR",
};

export function coinLogoSrc(symbol: string): string | null {
  const upper = symbol.trim().toUpperCase();
  const coin = SAME_LOGO_AS[upper] ?? upper;
  return COINS.has(coin) ? `/coins/${coin.toLowerCase()}.svg` : null;
}

export function CoinAvatar({ symbol, color }: { symbol: string; color: string | undefined }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = coinLogoSrc(symbol);
  if (src && src !== failedSrc) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setFailedSrc(src)}
        className="size-10 shrink-0 rounded-full ring-1 ring-rule"
      />
    );
  }
  const tint = color ?? "var(--color-muted-foreground)";
  return (
    <span
      aria-hidden
      data-testid="coin-letter"
      className="flex size-10 shrink-0 items-center justify-center rounded-full font-figure text-sm font-medium"
      style={{
        color: tint,
        backgroundColor: `color-mix(in oklab, ${tint} 16%, var(--color-card))`,
      }}
    >
      {symbol.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
