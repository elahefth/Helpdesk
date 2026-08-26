import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A plain `<textarea>`, unlike `Input`, which wraps Base UI's input primitive:
 * Base UI has no textarea, and there is nothing here for one to add — no
 * validity coordination, no composed ref, no popup. The class list is Input's
 * with the fixed height traded for `min-h` + `field-sizing-content`, so a reply
 * box grows with what is typed instead of scrolling inside three lines.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content min-h-24 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
