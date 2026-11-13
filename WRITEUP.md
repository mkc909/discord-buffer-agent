# Discord Buffer Agent — Buffer Commit submission write-up

**Project:** Discord Buffer Agent (working name)
**What it is:** A Discord app that lets a team run its Buffer publishing from inside Discord — slash commands and approval buttons on the front, a durable agent holding the publishing state behind them, and Buffer's ContentItem API at the core.
**Stack:** Cloudflare Worker + Cloudflare Agents SDK (durable objects) + Buffer GraphQL API (direct rail)

---

## The problem

Small teams, agencies, and communities already live in Discord. Their publishing does not. It lives in a separate dashboard that someone has to remember to open, in a separate tab, with a separate mental model of drafts, channels, and schedules.

So the actual work of publishing — draft an idea, talk it over, adapt it per channel, get a second pair of eyes, schedule it — happens in chat anyway, and then someone copy-pastes the result into the publishing tool. The conversation and the publication drift apart. Approvals happen in a thread nobody can audit later. The tool of record says one thing; the team remembers another.

This app moves the whole loop into the chat the team is already in.

## What it does

A team member drafts, discusses, approves, and schedules Buffer content without leaving Discord:

| Command | What it does |
|---|---|
| `/draft <text> [title] [target_date]` | Creates a channel-less ContentItem draft in Buffer and opens a Discord thread on the message as that item's editorial room |
| `/attach <channel_id> [item_id]` | Attaches a channel to the item. The first channel promotes the draft to posts; later channels are composed and attached the same way |
| `/queue` | Shows everything awaiting approval, approved, or scheduled |
| `/approve <item_id>` | Records a human approval for the item |
| `/status [item_id]` | Shows the item's phase, its posts per channel, its approval state, and the last read-back verification |

**One thread per ContentItem.** Each item gets its own Discord thread — its editorial room. The discussion, the variants, and the decision all live in one place, mapped durably to the Buffer item behind it.

**A human approval gate, enforced in code.** Buttons on the item message mirror the gate: Approve, Schedule, Revoke approval, Status. An approval is bound to the item's exact current content version and expires after 24 hours. Any content change — attaching or detaching a channel, for example — bumps the content version and invalidates earlier approvals, so a changed item has to be approved again. Scheduling is the only path that can send a post onward, and it refuses without a live, unexpired, version-matching approval. This is not a convention or a prompt instruction; the scheduling code path throws without the approval.

**A drift watcher for an experimental API.** The ContentItem surface is experimental, so the app treats schema change as a normal event, not a surprise. Every six hours a scheduled check introspects the live Buffer schema, diffs it against a pinned snapshot of the ContentItem surface, and posts an alert to a Discord webhook if the surface moved. (This watcher has already caught real drift — see "Built during the window" below.)

## Architecture

```
Discord (slash commands / buttons)
        │  HTTP interactions, Ed25519-signed
        ▼
Cloudflare Worker — verifies the Ed25519 signature BEFORE any handling
        │  ping/pong · command router · deferred follow-ups
        ▼
PublishingAgent (Cloudflare Agents SDK, one durable agent per organization)
        │  ContentItem ↔ thread mapping · draft state · approval records
        │  the approval gate lives here
        ▼
Buffer API — direct GraphQL rail (api.buffer.com)
```

Design choices worth naming:

- **HTTP interactions, no gateway bot.** Discord delivers slash commands and button taps to the Worker over signed HTTP. There is no always-on bot connection to babysit, and the Worker rejects any interaction whose signature does not verify before any handling runs.
- **Durable state, not chat logs.** One durable agent per organization holds the ContentItem-to-thread mapping, draft state, approval records, and follow-up alarms. Follow-ups verify items against Buffer by read-back and record the verdict, so the agent's memory of what went out and who approved it is structured state, not scrollback.
- **Direct GraphQL rail, API first.** The product talks to Buffer's GraphQL API directly. Buffer's hosted MCP server is used only as a development and testing tool, never as a product dependency — a distinction the drift event below proved out.
- **Source stays home.** The team's own content system remains canonical for source content and provenance. Buffer is the distribution layer; this agent is the workflow surface between them.

## How it uses the Buffer API

The app is built on the ContentItem model — one logical content identity above independently adapted channel posts. The ContentItem operations it uses:

- `createContentItemDraft` — channel-less draft creation (the `/draft` command); content is nested under the draft input, a live-schema shape confirmed by testing, not by the guide alone
- `promoteContentItemDraftToPosts` — first-channel promotion of a draft into posts
- `addPostToContentItem` / `removePostFromContentItem` — attach and detach posts after promotion, without deleting the post
- `updateContentItem` / `updateContentItemDraft` — item title and target-date updates
- `deleteContentItem` — cleanup and end-of-life
- `Post.contentItemId` — traversal from a post back to its parent item

Plus the post operations around them:

- `createPost` — a standalone draft post, composed with `addPostToContentItem` to attach an additional channel to an already-promoted item
- `editPost` — scheduling. A draft post is scheduled with mode `customScheduled` and a due date (or queued with mode `addToQueue`). Live testing established a shape fact the docs do not state: `editPost` validates the whole post, so the caller must read the post back and re-supply its current text, or the call fails. The agent's scheduling path does exactly that, behind the approval gate.

Every state change is verified by reading the result back from Buffer.

## Built during the build window (Oct 28 – Nov 13)

The ContentItem integration underneath this app predates the contest (see the feedback story below). What was added during the Buffer Commit build window:

- **Scheduling, live-confirmed and implemented (Oct 31).** The scheduling operation was an open stub. A live, draft-only test run confirmed `editPost` as the scheduling operation — custom-scheduled, queue, and revert-to-draft variants — including the re-supply-the-text requirement. `schedulePost` was then implemented in the agent behind the approval gate.
- **Attach-a-channel composition, live-confirmed and implemented (Oct 31).** Attaching an additional channel to a promoted item was confirmed live as the composition standalone `createPost` (draft) + `addPostToContentItem`, with detach verified clean in the same run. Implemented as the agent's `attachChannel`.
- **Relationship-document fixes (Oct 31).** The live payloads for `addPostToContentItem` and `removePostFromContentItem` are unions of a Success type and a `VoidMutationError` — there is no Failure type for these mutations, and the Success members carry no message field. The agent's GraphQL documents selected fields that do not exist on those unions and failed live validation. Both the agent and our Buffer MCP proxy were corrected to fragment form and re-verified live.
- **Drift watcher re-sourced (Oct 31).** Between Oct 24 and Oct 31, Buffer's hosted MCP server dropped its three advanced tools (`introspect_schema`, `execute_query`, `execute_mutation`) — 17 tools listed on Oct 31, down from 20. That removed the watcher's original schema source and the earlier test lane with it. The watcher was rebuilt the same day on direct GraphQL introspection, and both schema pins were updated. The ContentItem surface itself showed no drift against the Oct 24 pin — the operations and input shapes were identical, with additive fields only elsewhere. This is the API-first decision working as designed: the hosted MCP was a convenience, never a dependency, so losing it broke nothing in the product.
- **Buffer OAuth connection (Nov 13).** Connecting the deployed agent through Buffer OAuth — the contest's eligibility connection — in place of a personal API key for the public deployment, landing on submission day.

## The feedback story

This project exists because Buffer asked, and listened.

Working on a publishing system of our own, we gave feedback in Buffer's Discord developers channel on the ContentItem community preview: the name works; the draft state is genuinely useful to integrations; but the relationship operations were missing — a post needed a way back to its item, an existing post needed a way to attach, a post needed to detach without being deleted, and an item needed to grow new channels after promotion.

On September 23, Buffer shipped those operations in the experimental API — `addPostToContentItem`, `removePostFromContentItem`, and `Post.contentItemId` — and tagged us in the thread asking for feedback.

So we tested before replying. The relationship operations were wired into our integration and validated live in September — draft posts, attach, idempotent attach retry, parent lookup, detach, retry, detached lookup returning null, cleanup — draft-only throughout, nothing published. In October we tested the questions that remained (draft readability after promotion, post-promotion tag changes, the PostGroup relationship, archive semantics) against the live API the same way, and in the build window we settled scheduling and attach composition by live runs with every test object deleted and its deletion verified by read-back.

The findings from those runs — the kept draft is not readable after promotion, tags cannot change after promotion, there is no archive operation distinct from delete — are the kind of thing you only learn by building on the surface for real. This agent is that building, continued.

## Safety rules baked in

- Official Discord Bot API only. No user-account automation, no gateway bot.
- No scheduling or publishing without a human approval tap — enforced in the agent's code, not by convention.
- Secrets live only as Worker secrets or local development variables; never in source, files, or git.
- Every state change is verified by read-back from Buffer.
- Testing discipline on the live account: draft-only objects, test objects deleted after each run, deletion verified.

## Honest limits

- The drift watcher alerts on schema change; automatically filing the change as a tracked claim is a marked hook, not yet wired.
- Target-date nudges are scheduled and recorded by the agent; posting the nudge into the item's thread is still to do.
- The MCP rail remains in the codebase for development symmetry but is not a working upstream today, for the reason described above; the GraphQL rail is the product.
