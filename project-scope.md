# AI-Powered Ticket Management System

## Problem

We receive hundreds of support emails daily. Our agents manually read, classify, and respond to each ticket — which is slow and leads to impersonal, canned responses.

## Solution

Build a ticket management system that uses AI to automatically classify, draft responses to, and route support tickets — delivering faster, more personalized responses to students while freeing up agents for complex issues.

The AI drafts; the agent decides. Nothing reaches a student without a human sending it.

---

## Decisions

| Area | Decision |
|---|---|
| Stack | React SPA + separate Node/Express API |
| Database | Postgres |
| Email intake | Mocked for V1, behind an adapter interface so Gmail API or an inbound webhook drops in later without touching the ticket pipeline |
| Ticket data | ~150 seeded tickets for a fictional online course platform / bootcamp — realistic mix, multi-message threads, varied tone, edge cases the AI should decline to answer |
| AI | Real Claude API calls for classification, summarization, and reply drafting |
| Reply policy | Draft-only. Agent reviews, edits, and sends. No auto-send in V1 |
| Knowledge base | Synthesized from the seeded ticket archive, so retrieval has coherent content to hit |
| Users | Staff only — admin and agent roles. Students never log in; they exist only as email addresses on tickets |
| Outbound mail | Simulated outbox. Approved replies are stored and shown in the thread; nothing leaves the machine |

---

## Domain

The mock data portrays support for an **online course platform / bootcamp**. Ticket categories:

- Enrollment & Registration
- Payments, Billing & Refunds
- Course Access & Login
- Technical Issues (video, IDE, submissions)
- Curriculum & Course Content
- Certificates & Completion
- Career Services
- Other / Needs Human

Every ticket is also assigned a **priority** (`low` / `normal` / `high` / `urgent`) and a **routing target** (the queue or team that should own it).

---

## Ticket Lifecycle

```
new → open → pending → resolved → closed
```

- **new** — ingested, classified, not yet touched by an agent
- **open** — an agent owns it and is working it
- **pending** — waiting on the student to reply
- **resolved** — answered; reopens automatically if the student writes back
- **closed** — terminal

Tickets can be assigned to an individual agent at any point.

---

## Features

### Ingestion
- Receive support emails and create tickets
- Thread replies onto existing tickets rather than creating duplicates
- Adapter interface with a mock source in V1; real sources pluggable later

### AI
- Ticket classification — category, priority, routing target
- Ticket summaries for long or multi-message threads
- Suggested replies grounded in the knowledge base, with the sources used shown to the agent
- Explicit low-confidence signal so the AI can say "this needs a human" instead of guessing

### Agent workspace
- Ticket list with filtering and sorting (status, category, priority, assignee, age)
- Ticket detail view — full thread, AI summary, classification, draft reply
- Edit and send the draft; edits are captured (see below)

### Knowledge base
- Articles derived from the seeded ticket archive
- Retrieval to ground reply drafts
- Editable in-app so agents can correct bad grounding

### Admin
- User management (admin only) — create agents, assign roles
- Dashboard to view and manage all tickets

### Measurement
- Volume by category and priority over time
- Time to first response, time to resolution
- **Draft acceptance rate** — how often a draft is sent unedited, lightly edited, or discarded

---

## Feedback Loop

The diff between what the AI drafted and what the agent actually sent is the strongest available signal about reply quality. Every send records the original draft, the final text, and the edit distance between them.

This is cheap to build now and expensive to retrofit. It is what makes V2 measurably better than V1 rather than merely different.

---

## Out of Scope for V1

- Student-facing portal or student logins
- Auto-sending replies without human review
- Live email delivery
- SLA rules and breach alerting
- Multi-language support
- Mobile app

---

## Open Question

**Auth depth.** Roles are settled (admin, agent), but not the implementation: real auth with hashed passwords and sessions, or seeded logins with a demo role switcher. Real auth is the safer default if this is ever pointed at a live mailbox — flagging it rather than assuming.
