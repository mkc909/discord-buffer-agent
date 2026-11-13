# Privacy Policy — Discord Buffer Agent

*Last updated: November 13, 2026*

The Discord Buffer Agent ("the app") is a Discord application that lets a team draft, approve, and schedule social media posts to Buffer from inside Discord. This policy explains, in plain language, what data the app touches, why, and what it never does.

## What the app touches

- **Discord identifiers.** Your Discord user ID, the ID of the server (guild) the app is installed in, and the IDs of channels and threads where the app is used. These are used to map a Buffer content item to its discussion thread and to record who approved what.
- **Content you submit for publishing.** The text, titles, and target dates you enter through the app's commands, and the channel posts created from them. This content is sent to Buffer through the Buffer API so it can be drafted, scheduled, and published by Buffer on the accounts you connected.
- **Buffer authorization.** When you connect a Buffer organization, the app stores the Buffer access token from that OAuth authorization. Tokens are stored as encrypted Worker secrets or in the app's durable storage on Cloudflare, protected by the operator's Cloudflare account. Tokens are never written into source code, logs, or messages.
- **Operational records.** The app keeps records of its own actions: which content item belongs to which thread, draft and approval state, scheduling results, and verification read-backs from Buffer. Approval records include the Discord user ID of the person who approved and when the approval expires.

## What the app never does

- **It never publishes or schedules anything without a human approval.** Scheduling is blocked in the app's code until a person approves the exact current version of the content.
- **It never sells your data.** Data is not sold, rented, or shared with advertisers or data brokers.
- **It never uses your content for advertising or model training.**
- **It never automates a personal Discord account.** The app uses the official Discord Bot API only.

## Who else processes the data

The app runs on Cloudflare (Workers and durable storage). Content you submit is sent to Buffer through the Buffer API, and interactions go through Discord. Those services process data under their own privacy policies. The app sends each service only what the feature you used requires.

## Retention and deletion

- Operational records are kept while a server uses the app, so approvals and scheduling history remain auditable.
- If you disconnect Buffer or remove the app from your server, ask us to delete your data (contact below) and we will delete the stored tokens and the operational records for that server, except anything we are legally required to keep.
- Content already delivered to Buffer is governed by Buffer's retention and deletion controls in your Buffer account.

## Security

Buffer tokens and Discord credentials are held as platform secrets, access is limited to the operator, and the app verifies Discord's signature on every interaction before acting on it.

## Changes to this policy

If this policy changes in a material way, the updated version will be posted at this URL with a new "last updated" date.

## Contact

Questions, or a deletion request: **mike@michaelcourtney.com**
