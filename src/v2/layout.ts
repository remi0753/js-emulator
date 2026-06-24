// Address-space policy for the TypeScript v2 kernel.

export const LAYOUT = {
  USER_TEXT: 0x1000, // program image is loaded here (page 0 left unmapped = null guard)
  USER_STACK_TOP: 0x10000, // stack grows down from here
  USER_STACK_PAGES: 4,
} as const;
