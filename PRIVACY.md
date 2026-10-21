# Privacy Notice

Last updated: October 21, 2026

This notice describes the hosted LINE ↔ Discord Sync service operated by Pitichod. If you run your own deployment, you are responsible for the data handled by your deployment and for publishing an appropriate privacy notice.

## What the service handles

When a chat is paired, the service receives messages and supported attachments from LINE or Discord so it can relay them to the paired chat. This can include message text, file or image contents, usernames, profile names and images, platform user and chat identifiers, and reply information. Discord message content access is enabled because relaying message text is a core feature.

The Worker processes message contents to relay them. The bridge does not intentionally save message text or attachment contents in its own Durable Object storage. LINE, Discord, Cloudflare, and any linked file hosting service may process or retain data under their own terms and privacy practices.

## Data saved by the bridge

- Pairing metadata linking a LINE chat and a Discord channel or DM, including Discord server and pairing-owner IDs where available. Kept until `/unpair` is used.
- Temporary pairing codes and their channel references. Codes expire after 10 minutes and are pruned during later pairing activity.
- Discord webhook ID and token used to display LINE profile names and images in Discord. Kept while paired; `/unpair` asks Discord to delete the webhook and removes its stored credential.
- Message IDs and LINE quote tokens used to create cross-platform reply links. Kept for up to 30 days, limited to the latest 500 messages per pair, and removed when `/unpair` is used.
- LINE webhook event IDs used to prevent duplicate processing. Kept for up to 24 hours.

The Worker logs operational details such as event type, source type, message counts, and provider response status. It is designed not to log message text, attachment contents, or access tokens. Cloudflare may separately process Worker logs and operational data under its own terms.

## How data is used and shared

The service uses this information only to pair chats, relay messages and attachments, support replies, prevent duplicate delivery, and keep the bridge operating. Message contents and supported attachments are sent between LINE and Discord through the service. The hosted service uses the operator's LINE Official Account, Discord bot, and Cloudflare account; use may consume their quotas. Data is also handled by those providers as necessary to deliver the service.

## Deletion and unpairing

Run `/unpair` in the paired Discord channel or DM to stop relaying and delete the bridge's pairing metadata, reply-link records, and stored webhook credential. The service also requests deletion of the Discord webhook. If Discord is unavailable or rejects that request, the service still deletes the locally stored credential; the webhook may need to be removed by a Discord server administrator.

Unpairing does not erase messages already delivered to LINE or Discord, provider logs, or copies retained by those platforms. For a privacy question or a request that cannot be handled with `/unpair`, contact [ninepitichod@gmail.com](mailto:ninepitichod@gmail.com). Do not post personal information in a public issue.

## Security and changes

The operator uses Cloudflare Worker secrets for platform credentials and limits stored reply links. No internet service can guarantee perfect security or uninterrupted availability. This notice may be updated as the project changes; the date above indicates the latest revision.

## Applicable requirements

This notice is a description of the project's current behavior, not a legal guarantee that the hosted service meets every privacy law in every location. The service operator must assess applicable privacy, data-protection, consumer-protection, and platform requirements for the users and locations served. Discord requires an Application privacy policy that explains data collection, use, sharing, and deletion requests; the operator should set this document's public URL in the Discord Developer Portal before offering the hosted bot publicly.
