import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * Renders a component under a throwaway QueryClient.
 *
 * A fresh client per call is the point: React Query caches by query key, so a
 * shared one would let a resolved page leak into the next test and make the
 * pending state unassertable.
 *
 * `retry` is off, unlike the app's client in main.tsx, so an error case settles
 * on the first response instead of waiting out a retry.
 */
export function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    ),
    queryClient,
  };
}
