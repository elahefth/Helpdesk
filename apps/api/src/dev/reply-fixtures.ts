/**
 * One long conversation, committed rather than generated.
 *
 * `dev/seed-replies.ts` writes these onto a ticket to produce the thing the
 * repo otherwise has none of: a ticket somebody has actually been working for
 * a fortnight. Everything that reads a thread — the detail page's scroll, the
 * summariser's prompt, the unpaginated `GET /api/tickets/:id/replies` — behaves
 * differently at twenty messages than at two, and a fixture is how that becomes
 * reproducible instead of something one developer once had locally.
 *
 * Written for the capstone-scope ticket it was seeded against, the same way
 * `ticket-fixtures.ts` is written as a hundred specific emails rather than a
 * generator: plausible text is what makes a summary worth reading, and a
 * template that fills in `{{topic}}` twenty times produces a thread that only
 * looks long. Seed it onto some other ticket and the words will not match the
 * subject — that is the trade, and it is the right way round for a fixture
 * whose whole job is to be read.
 *
 * Three properties are load-bearing and `reply-fixtures.test.ts` pins all
 * three, because each fails silently — as a thread that renders perfectly and
 * tests nothing:
 *
 * - **Twenty messages.** Enough that the page scrolls and the summariser has
 *   to choose what to leave out.
 * - **Strict alternation, opening with the agent.** The student's first
 *   message is not here: it is `ticket.body`, the email that created the
 *   ticket, so the thread begins with the answer to it. A run of two turns
 *   from one side would be an ordinary support thread and a poor test — the
 *   interleaving is what makes "who said what" a question a summary can get
 *   wrong.
 * - **At least ten non-empty lines each.** A ten-line message is where a
 *   summary stops being an extract and starts being a judgement about what
 *   mattered.
 *
 * The arc is deliberate too. Threads are opened and left open — an extension
 * the helpdesk cannot grant, a supervisor who does not reply for a week,
 * employer-owned code that has to be rewritten — and the last word is a
 * question nobody has answered yet. A conversation that resolves tidily gives
 * a summariser nothing to put under "Outstanding".
 */

export interface ReplyFixture {
  /**
   * Who is speaking. The seed script maps `student` onto a stand-in author,
   * because `ticket_reply.author_id` is NOT NULL and points at `user` — see
   * `seed-replies.ts` for what that stand-in is and why it is safe.
   */
  from: "agent" | "student";
  /**
   * Hours since the previous message, irregular on purpose: a thread on a tidy
   * cadence is one where nobody was waiting, and waiting is most of what a
   * support thread records. The gaps run from two hours to two days, which is
   * what puts a weekend-shaped hole in the middle of it.
   */
  hoursAfter: number;
  /** Plain text, like every other body in this app. */
  body: string;
}

export const REPLY_FIXTURES: ReplyFixture[] = [
  {
    from: "agent",
    hoursAfter: 3,
    body: `Hello Yuki,

Thanks for checking before you start. That is the right time to ask, and it saves a rewrite in November.

The short answer: the capstone does not have to be a single application.

What the brief means by "a substantial project" is the amount of design and engineering work involved, not the number of programs it ends up as.

Several smaller pieces can qualify, but they have to hang together:

- They should answer one problem statement, not just share a subject area.
- There should be a reason they are separate pieces rather than one, and you should be able to state that reason in a sentence.
- At least one of them has to carry real technical depth.

The third point is where most of these come unstuck. Three thin pieces do not add up to one substantial one.

A web app, a command-line tool and a dashboard that all read the same database can look like three projects and assess like one.

If you tell me roughly what you have in mind, I can tell you whether it reads as one project or three.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 19,
    body: `Thanks, that helps a lot.

What I have in mind is a study planner, built as three pieces:

1. A web app where you enter your modules, deadlines and how long you think each piece of work will take. It builds a schedule and adjusts it when you fall behind.
2. A command-line tool over the same data, because I do most of my work in a terminal and I would actually use it.
3. A browser extension that spots deadlines on the university's course pages and offers to add them.

All three would share one scheduling library and one local database, so the logic lives in a single place and the pieces are just ways in.

The part I think is genuinely hard is the rescheduling.

When you miss a block of work, everything after it has to move. But some things cannot move, because they are fixed deadlines. Others can only move so far before they collide with something else.

I was going to treat that as a constraint problem rather than shuffling items down a list.

Does that read as one project or three? I would rather find out now.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 5,
    body: `Hello Yuki,

That reads as one project, and the reason is the scheduling core.

Three ways into one piece of real logic is a different thing from three small applications that share a database. Your own description already draws that line.

A few things worth knowing before you commit:

The rescheduling will be assessed most closely, so it should be where you spend your time.

Treating it as a constraint problem is defensible, but you will be asked why you chose that over something simpler. "It was more interesting" is not the answer markers want. Have a reason that involves the problem.

The three front ends are worth less than you would think. Two would do.

Nobody has lost marks for building two interfaces instead of three. Several people have lost marks for building three and finishing none of them.

One process point: the scope has to be signed off by your supervisor before you start, on the project proposal form.

That is not a formality. If the scope changes later, the sign-off is what you point at.

Do you know who your supervisor is yet?

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 27,
    body: `I have been allocated Dr Whitfield, but I have not spoken to her yet.

I emailed her last Tuesday with a short version of what I sent you. Nothing back so far.

I do not know whether that is normal at this point in the year, or whether I should be chasing.

Two things I want to check, because the deadline is starting to worry me.

First, the proposal deadline in the handbook is the 5th. If I cannot get sign-off before then because she has not replied, what happens?

Am I marked late for something that is not my doing?

Second, is the sign-off a signature on the form, or does she submit something separately? The handbook says "agreed with your supervisor", which could mean either.

I would rather not spend a week building something that gets rejected on the 5th.

If there is a version of this I can safely start on now, I would rather begin there. The scheduling core seems like the obvious candidate, since it is in the project whatever the scope turns out to be.

Is that a reasonable way to handle it?

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 2,
    body: `Hello Yuki,

Taking those in order.

A week without a reply is on the long side but not unusual in August. A lot of academic staff are on leave and return to several hundred emails.

It is worth chasing, and worth doing now rather than waiting for the 5th.

On the deadline: a proposal held up by a supervisor who has not replied is not counted against you.

What you need is evidence that you tried in good time. Your email from last Tuesday is that evidence, so keep it.

Forward it to her again with a short note, and copy the module lead, Dr Aitken, so there is a record outside the two of you.

On the form: it is a signature on the proposal form. She does not submit anything separately. You fill it in, she signs it, you upload it.

On starting early: yes, and the scheduling core is the right choice. It survives any plausible change of scope.

What I would not start on is the browser extension, which is the piece most likely to be cut.

One thing I cannot do is grant an extension. That sits with Dr Aitken as module lead, not with the helpdesk. If it comes to that, ask him directly.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 48,
    body: `I have resent it and copied Dr Aitken as you suggested. Still nothing from Dr Whitfield.

In the meantime I have started on the scheduling core, and I have hit a question I did not expect.

A friend on the same course, Priya, is building something adjacent. Hers is about timetabling for group work rather than individual study.

The underlying problem is close enough that we keep sending each other the same papers.

We have been talking about sharing the constraint solver: one implementation, both projects, each of us building our own thing on top.

It would be a better solver than either of us would write alone. It would also mean a substantial part of my project is not only mine, and I do not know how that is treated.

Some specific questions:

Is it allowed at all, or is the capstone strictly solo?

If it is allowed, do we submit the shared part once or twice?

Does it count against the "substantial" test if the hardest component is shared?

And if it is fine but has to be declared, where does the declaration go — the proposal, the report, or both?

I would rather ask now than explain it in a viva.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 6,
    body: `Hello Yuki,

Good instinct to ask. The answer is more permissive than people expect, with one condition that does most of the work.

The capstone is an individual submission, but it is not a solitary one.

Collaborating on a shared component is allowed. What is not allowed is a submission that does not make the collaboration visible.

In practice:

You each submit your own project, separately, with your own report. There is no joint submission and no joint mark.

The shared solver appears in both submissions. That is fine.

It is declared in both, in the same terms, and the declaration says who wrote which parts. "We wrote it together" is not enough detail — markers want to know what you could explain in a viva.

It is declared in two places: a line in the proposal saying you intend to share a component, and a section in the final report setting out what was shared and how the work divided.

The proposal line matters more than it looks. It is what stops this being a surprise at the end.

On your third question, and this is the one to think hardest about: yes, it counts against you if the hardest component is the shared one.

Not because sharing is penalised, but because what is left is what you are marked on. If the solver is the interesting part and you share it, you need something else of your own that is interesting.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 20,
    body: `That is clearer than the handbook, thank you.

We have decided to split it differently in light of that.

Priya is writing the solver. I am writing the model — the part that turns modules, deadlines and estimates into constraints, and turns the solver's output back into something a person can read.

So the shared piece is hers, and the part I am marked on is mine. She will declare it the same way round.

Now a different problem, and I think this one is worse.

Over the summer I did an internship at a logistics company. Part of what I worked on there was a scheduling component with the same shape as this.

Not the same code. But I learned how to do it there, and honestly some of the structure in my head is theirs.

I have not copied anything.

But I did keep a copy of a utility module I wrote — date handling, working-hours arithmetic, that sort of thing — and I was going to use it. Rewriting it would take a week and teach me nothing.

Is that allowed? It is code I personally wrote. It is also code I wrote on their time, on their laptop.

If the answer is no, I need to know now, because a week is a week I do not have.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 4,
    body: `Hello Yuki,

Thank you for raising it. I know it is not a comfortable thing to ask about, and asking is the right call.

Two separate questions are tangled together here, so let me take them apart.

The first is academic: may you submit code you wrote before the module started?

Yes, with declaration. Reusing your own prior work is allowed as long as the report says what it is and where it came from, and as long as it is not the part being assessed.

Utility code for date arithmetic is exactly what that rule exists to permit.

The second question is legal, and it is the one that actually decides this: who owns the code?

If you wrote it during an internship, on their equipment, in working hours, then under most employment contracts your employer owns it, not you. Your internship agreement will say.

That is not a university rule, and the university cannot waive it.

So the order of operations is: find your internship agreement, read the intellectual property clause, and if it says what those clauses usually say, write to your former manager and ask for permission in writing.

If they say yes, keep the email and declare the code in your report.

If they say no, or do not reply, you rewrite it. I know that is the answer you did not want.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 30,
    body: `They said no.

To be fair to them it was a polite no, and quick — my old manager replied within a day.

The company's position is that anything written during the internship is theirs, and they do not licence it out, even the boring parts. Once they start making exceptions they need a policy about it.

I understand the reasoning. It does not help me.

So I am rewriting the date handling from scratch. It is going more slowly than I estimated, which I should probably have expected given that is the entire subject of my project.

Where that leaves me:

The scheduling core is about half done.

The model layer — the part that is mine to be marked on — is sketched but not built.

The web app is a login page and nothing else. The command-line tool does not exist. The browser extension definitely does not exist.

Dr Whitfield has still not replied. Sixteen days since my first email, six since the one copying Dr Aitken.

The proposal deadline is in four days.

I think I need to cut something, and I think it should be the browser extension, which you already suggested.

Can I confirm: does cutting scope need her sign-off too, or only the original proposal?

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 8,
    body: `Hello Yuki,

Sixteen days is no longer a slow reply, it is a problem to escalate. I am sorry you have carried it this long.

I have flagged it to Dr Aitken's office this morning with the dates, so it is on record from our side as well as yours. You should hear something this week.

On your question: cutting scope before the proposal is signed is not a change of scope at all. It is just your proposal.

Write the version with two front ends instead of three and submit that. There is nothing to get approval for, because nothing has been approved yet.

It is after sign-off that changes need agreeing, and even then the rule is proportionate — dropping a component needs a note to your supervisor, not a new form.

So: cut the browser extension, and cut it in the proposal rather than quietly later.

I would also say, gently, that the plan you describe is still ambitious for the time left.

A command-line tool over a solid model layer is a complete project. A half-built web app beside it is not worth the marks it costs you.

You do not have to decide that today. Decide it before you start the web app in earnest.

On the deadline: submit the proposal on the 5th whether or not it is signed.

An unsigned proposal submitted on time is an administrative problem. A signed one submitted late is a mark penalty.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 16,
    body: `She replied.

Whatever your colleague did, it worked. Dr Whitfield emailed last night and apologised.

She had been on leave with her email forwarding to someone who has also been on leave.

She has read the proposal and is happy with the two-piece version.

She has asked for two changes.

First, she wants the evaluation section to be more specific. At the moment I have written that I will "evaluate the scheduler against realistic workloads", and she has pointed out, correctly, that this does not say what would count as success. She wants a measurable claim.

Second, she wants me to say what happens when the solver cannot find a schedule at all.

That is a case I had not thought about properly. If you are far enough behind, there is no valid arrangement of the remaining work, and the tool should say so rather than produce something impossible.

So I have work to do, but I have a supervisor again.

Two questions on the proposal document itself, since I am rewriting it anyway.

What is the word count? And is there a template? The handbook mentions one, but the link goes to last year's page, which is now empty.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 3,
    body: `Hello Yuki,

Good news, and her two points are both worth taking seriously — the second especially.

A tool that tells you the truth when the answer is "this cannot be done" is a better project than one that always returns something.

On the document:

The word count is 1,500 words, excluding references and appendices.

It is a limit rather than a target. Nobody has been marked down for 1,200 words that say everything.

The template does exist, and the handbook link is stale. That page moved when the department reorganised its site over the summer, and several links did not follow.

The current one is under Course Resources, in the Capstone folder, named Project Proposal Form. I have asked for the handbook link to be corrected.

Since you are rewriting anyway: the sections markers pay most attention to are the evaluation plan and the risk section, in that order.

Your supervisor has just told you the same thing about the first one.

On making the evaluation measurable, the usual shape is a specific input, a specific thing you measure, and a number you decided in advance.

"The scheduler produces a valid arrangement for 90 per cent of generated workloads within two seconds" is the kind of claim that can be right or wrong. That is what makes it an evaluation.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 50,
    body: `Proposal is in, with two days to spare.

Thank you — genuinely. This would have gone badly without the escalation.

I have rewritten the evaluation section around three claims: a validity claim, a timing claim, and one about how far the schedule moves when you miss a single block of work.

That third one turns out to be the interesting measure. If missing two hours of work rearranges your entire term, the tool is technically correct and useless. So I am measuring how much it disturbs.

The unsatisfiable case is now a section of its own.

The tool reports which constraints are in conflict rather than just failing, which I think is a better answer and is also, conveniently, something the solver can already tell me.

Next question, and I am asking early this time.

The handbook says the capstone is assessed by "report, artefact and demonstration". I understand the first two.

What actually happens in the demonstration? Is it a presentation to a room, or a conversation at a desk?

Is it marked separately?

And am I expected to demo on my own laptop or on university equipment?

I ask because the tool needs a database and a terminal, and I have watched enough presentations fail on a projector to want to know in advance.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 7,
    body: `Hello Yuki,

Congratulations on getting it in. The evaluation you describe is considerably stronger than the one you started with.

The disturbance measure is a good idea. It is the kind of thing that comes from thinking about the user rather than the algorithm.

On the demonstration:

It is a conversation at a desk, not a presentation to a room.

Twenty minutes, usually your supervisor and one other member of staff. You show the thing working and they ask you about it.

It is marked as part of the whole rather than separately, but it carries real weight in one specific way: it is where markers decide how well you understand your own code.

People lose marks there by being unable to explain a decision they made in March.

Bring your own laptop. Most people do, and the department has adaptors for the usual connectors. You will not need the projector for a desk demo.

The advice I would give anyone:

Have the thing already running before they arrive.

Have a small dataset prepared that shows the interesting case rather than the happy path.

Know how to get back to a working state if you break it.

Demonstrating the unsatisfiable-schedule report would be a good use of five of your twenty minutes.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 22,
    body: `That is reassuring. A desk conversation I can manage.

A question about testing, which I have been putting off.

At the moment I have tests for the model layer — the part that turns modules and deadlines into constraints.

That is where a mistake is silent. If the model is wrong, the solver returns a perfectly valid schedule for the wrong problem, and there is nothing to notice.

I do not have tests for the command-line tool, and I am not sure what testing it would even mean. It reads arguments, calls the model, prints a table.

So:

Is there a testing requirement in the marking scheme, or is it assessed as part of general engineering quality?

Is there an expected coverage figure?

I have seen people on the course quoting eighty per cent at each other, and I do not know whether that is a real number from somewhere or something they made up.

And does the report need a testing section, or does it go in an appendix?

I would rather write the tests that are worth writing than chase a percentage.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 5,
    body: `Hello Yuki,

Your instinct in that last line is correct, so let me support it with the actual rules.

There is no coverage requirement.

The eighty per cent figure is not from the marking scheme. It is from a slide in a second-year module about a different topic, and it has been circulating ever since. Ignore it.

Testing is assessed as part of engineering quality, not as a separate criterion with its own number.

What markers look for is evidence that you tested the things where being wrong would be hard to notice — which is precisely the argument you just made about the model layer.

You have already worked out the principle. You do not need a percentage on top of it.

On the command-line tool: you are right that there is not much to test in argument parsing.

What is worth one or two tests is the seam between the tool and the model — that the arguments produce the call you think they produce. That is where a rename breaks something silently.

The report wants a testing section, not an appendix.

It is short: what you tested, what you deliberately did not test, and why.

The second half is the part people leave out, and it is the half that shows judgement.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 26,
    body: `Understood, and that is a relief. I will write the tests that catch silent failures and say so in the report.

I think I am nearly out of questions, which after three weeks of this feels strange.

One last area, and then I will leave you alone.

The submission itself.

The handbook lists a report, the artefact, and a "declaration", and says the artefact is submitted as an archive.

What I want to check is what goes in the archive, because my project now has a shape that does not fit neatly into one folder:

The model layer and the command-line tool are mine.

The solver is Priya's, and we are both submitting it, as we agreed and declared.

There is a small amount of third-party code — a date library and a table formatter — both open source and properly licensed.

Do I include the solver in my archive, or reference it?

Do the third-party libraries go in, or does a dependency list do?

And does the declaration cover all of it, or only the shared solver?

I would rather be over-careful here than have this come up afterwards.

Thanks,`,
  },
  {
    from: "agent",
    hoursAfter: 9,
    body: `Hello Yuki,

Over-careful is the right setting for this one, and your three categories are exactly the right way to think about it.

Include the solver in your archive.

The rule is that the artefact should build and run from what you submit, and a submission that needs a file only your collaborator has does not meet it.

Both of you submitting the same component is expected, and is what the declaration is for.

Third-party libraries go in as a dependency list, not as vendored code. Your dependency manifest is what a marker reads.

The exception is if you have modified one. Then the modified copy goes in, and the report says what you changed and why.

The declaration covers all of it: the shared solver, the third-party libraries, and any of your own prior work that survived.

One declaration, three sections. It is a short document, and nobody has been penalised for declaring too much.

One practical note: check that the archive actually builds somewhere that is not your laptop before you submit it.

Every year several artefacts fail to build for markers because of something that was only ever installed on the author's machine.

It has been a pleasure helping with this one. Good luck with the build.

Best wishes,`,
  },
  {
    from: "student",
    hoursAfter: 18,
    body: `Thank you — for all of it, but particularly for chasing Dr Whitfield. That was the week I thought this was going to fall apart.

I have one more question, and I am afraid it is practical rather than procedural.

I built the whole thing assuming a local database, which is fine on my laptop.

For the demonstration I want to show the disturbance measure on a realistic dataset — about four hundred tasks across a full term.

Generated rather than real, because real student data is not mine to use.

Generating it takes about eleven minutes on my machine, which is too long to do in front of two markers. So I want it prepared in advance.

The problem is that the prepared database is roughly nine hundred megabytes, and the submission system rejects anything over two hundred.

So:

Do I submit the generator and let markers create the dataset themselves, knowing it takes eleven minutes and they probably will not?

Do I submit a smaller sample and demo from the large one?

Is there somewhere else large artefacts are meant to go?

Nobody I have asked on the course knows, and the handbook does not mention size at all.

Thanks,`,
  },
];
