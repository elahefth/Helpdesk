import { useId } from "react";
import type { FieldError as FieldErrorValue } from "react-hook-form";
import type { UseFormRegisterReturn } from "react-hook-form";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * One labelled input of the staff-user form, shared by the create and edit
 * dialogs so the two cannot drift on the part that is easiest to get subtly
 * wrong: which element the label points at, and which ids `aria-describedby`
 * lists.
 *
 * It takes `register(...)`'s return value rather than the form's `register`
 * function. That keeps the component non-generic — each dialog resolves against
 * a different schema, so a shared component parameterised over field-value types
 * would need `Path<T>` casts at every call site to say nothing extra.
 *
 * Ids come from `useId` rather than a caller-supplied prefix because the edit
 * dialog is rendered once per table row. Only the open dialog's popup is
 * mounted, but Base UI keeps a closing popup around for its 150ms exit
 * transition, so opening one row's dialog while another is still closing would
 * briefly put two `#edit-user-name` inputs in the document.
 */
export function UserFormField({
  label,
  type,
  autoComplete,
  hint,
  error,
  registration,
}: {
  label: string;
  type?: "text" | "email" | "password";
  autoComplete: string;
  /** Rendered under the input and always announced, error or not. */
  hint?: string;
  error: FieldErrorValue | undefined;
  registration: UseFormRegisterReturn;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Both, in reading order, when both are present: the hint explains the field
  // and the error explains the rejection, and a screen reader needs the pair.
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        // Input styles its own invalid state off aria-invalid, so the red
        // border and the message stay in lockstep.
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...registration}
      />
      {hint && <FieldDescription id={hintId}>{hint}</FieldDescription>}
      <FieldError id={errorId} errors={[error]} />
    </Field>
  );
}
