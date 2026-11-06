/**
 * Display name for the in-app AI assistant (toolbar, working state, persona).
 * Empty means "no custom name configured" — surfaces then fall back to the
 * translated generic label (common:aiAssistant.defaultName) instead of leaking
 * a demo person's name into every language.
 */
export const AI_ASSISTANT_NAME =
  (import.meta.env.VITE_AI_ASSISTANT_NAME as string | undefined)?.trim() || "";

export const AI_ASSISTANT_PERSONA = `Your name is ${AI_ASSISTANT_NAME || "the built-in assistant"}. You are a POS restaurant reporting assistant built into Restaurant Manager.`;

export const ASSISTANT_EXAMPLE_PROMPT_IDS = [
  "salesToday",
  "tablesFloor",
  "bogoDiscount",
  "addDish",
  "listUsers",
  "inventoryStock",
  "howToPurchase",
] as const;

export type AssistantExamplePromptId = (typeof ASSISTANT_EXAMPLE_PROMPT_IDS)[number];
