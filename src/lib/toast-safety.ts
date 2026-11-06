import { isValidElement } from "react";
import { toast } from "sonner";

/**
 * Sonner renders its first argument as a React child. Call sites all over the
 * app pass the raw caught value (`toast.error(e)`), and an Error/plain object
 * is not a valid child — React throws inside the Toaster, and because nothing
 * in the tree had a boundary the whole POS used to unmount to a blank page.
 * Normalise non-renderable payloads once here instead of at 17 call sites.
 */
const toRenderable = (message: unknown) => {
  if (message === undefined || message === null) return "";
  if (typeof message === "string" || typeof message === "number" || typeof message === "boolean") {
    return message;
  }
  if (isValidElement(message)) return message;
  if (message instanceof Error) return message.message || message.name;
  return String(message);
};

const KINDS = ["error", "warning", "info", "success", "message"] as const;

for (const kind of KINDS) {
  const original = toast[kind].bind(toast) as (message: unknown, opts?: unknown) => unknown;
  toast[kind] = ((message: unknown, opts?: unknown) => original(toRenderable(message), opts)) as typeof toast[typeof kind];
}

export {};
