import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router";
import { AppLayout } from "./AppLayout.tsx";
import { LoginPage } from "./routes/LoginPage.tsx";
import { RequireAdmin } from "./routes/RequireAdmin.tsx";
import { RequireAuth } from "./routes/RequireAuth.tsx";
import { TicketDetailPage } from "./routes/TicketDetailPage.tsx";
import { TicketListPage } from "./routes/TicketListPage.tsx";
import { UsersPage } from "./routes/UsersPage.tsx";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// /login sits outside AppLayout so the signed-out screen has no nav bar, and
// everything else hangs off RequireAuth so a new route is protected by default.
const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: "/",
        element: <AppLayout />,
        children: [
          { index: true, element: <TicketListPage /> },
          // The queue keeps its bare "/" — there is no /tickets list —
          // but a single ticket needs an address of its own, because a
          // ticket link is how work gets handed between agents.
          { path: "tickets/:id", element: <TicketDetailPage /> },
          {
            element: <RequireAdmin />,
            children: [{ path: "users", element: <UsersPage /> }],
          },
        ],
      },
    ],
  },
]);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
