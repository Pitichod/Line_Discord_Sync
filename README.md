# LINE ↔ Discord Sync

Cloudflare Worker bridge for one Discord text channel and the first LINE chat that sends the Official Account a message.

## What it relays

- LINE text and received media (image, video, audio, file) are posted to Discord.
- Discord text is pushed to LINE. JPEG/PNG attachments up to 10 MB are sent as LINE images; other attachments are sent as links.
- The LINE Messaging API does not expose a general file-message type for sending, so non-image Discord files appear as links in LINE.

## Configure

1. Set `DISCORD_CHANNEL_ID` in `wrangler.jsonc` to the channel ID copied from Discord.
2. From this directory, store each credential as a Cloudflare secret:

   ```sh
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```

   Wrangler prompts for each value. Enter it in the terminal; do not put credentials in this file or commit them.

3. Deploy with `npx wrangler deploy`.
4. In LINE Developers Console, set the webhook URL to `https://line-discord-sync.<your-subdomain>.workers.dev/line-webhook` and enable webhooks.
5. Send a message in the intended LINE chat. The first LINE chat to message the Official Account is paired with the configured Discord channel; other LINE chats are ignored.

The Worker needs the Discord Message Content intent enabled. The bot must have view/send/read-history/attach-file access in the configured Discord channel, and the LINE Official Account must be in the paired LINE chat.

## Operations

- `GET /` reports whether the Worker is running.
- `POST /line-webhook` receives signed LINE webhooks.
- The Discord Gateway connection runs in a Durable Object. Cloudflare may incur Durable Object and Worker charges according to the account plan and usage.

This is an initial bridge implementation. Discord attachment links can expire, and files beyond LINE's image message support are forwarded as links.
