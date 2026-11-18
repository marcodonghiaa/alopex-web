/**
 * For a button that is busy (aria-disabled, its handler returns early) rather than disabled: a
 * disabled button drops keyboard focus to <body>. Same approach as the 2FA section.
 */
export const PENDING = "aria-disabled:pointer-events-none aria-disabled:opacity-50";
