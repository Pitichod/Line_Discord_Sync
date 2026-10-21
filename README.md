# LINE ↔ Discord Sync

Cloudflare Worker bridge that supports multiple Discord server channels or DMs, each paired with a LINE group or one-to-one chat. One deployment uses one Discord bot and one LINE Official Account; each pair is configured independently.

## Pair a channel and LINE group

1. In the Discord server channel or DM you want to connect, run `/pair`. The command returns a private, one-time code. In a server, it requires **Manage Channels**, **Manage Server**, or **Administrator** permission; in a DM, only the user who created the pairing can remove it later.
2. In the LINE group or one-to-one chat with the bridge's Official Account, send `!pair CODE`. For a group, add the Official Account first; for a one-to-one chat, start the chat with it first.
3. The Worker stores the channel-to-group pairing. Repeat for each Discord channel and LINE group.
4. To remove a pairing, run `/unpair` in the paired Discord channel or DM.

The bot must be installed in each Discord server and have view, read-message, send-message, attach-file, and **Manage Webhooks** access to the selected channel. Manage Webhooks lets LINE messages appear in Discord with the LINE sender's name and profile photo; without it, they fall back to a message sent by the bot with the sender's name in the text. The LINE Official Account must be a member of each paired LINE group, and **Allow bot to join group chats** must be enabled.

## Message behavior

- LINE messages use a Discord webhook named for the LINE sender and their profile photo when available. For Discord DM pairings and where the bot lacks Manage Webhooks, the bridge uses a bot message with the LINE sender's name.
- Messages from Discord use LINE's per-message sender name `Name (Discord)` and the Discord sender's profile icon when available; the chat text stays in a single bubble. LINE may append `from 'account name'` to the customized sender name.
- JPEG and PNG attachments up to 10 MB are sent to LINE as images. Other Discord attachments are shared as links because LINE's Messaging API has no general file-send message type. Discord attachment URLs may expire.

## Configure and deploy

1. Store the runtime credentials as Cloudflare secrets:

   ```sh
   npx wrangler secret put LINE_CHANNEL_SECRET
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```

2. In `wrangler.jsonc`, set `DISCORD_PUBLIC_KEY` to the **Public Key** shown under your Discord application's General Information. This value is public, unlike the bot token.
3. Deploy with `npx wrangler deploy`.
4. In Discord Developer Portal, set **Interactions Endpoint URL** to `https://<worker-host>/discord-interactions`.
5. Register the global `/pair` and `/unpair` commands. Set `DISCORD_APPLICATION_ID` to your Discord Application ID, then enter the bot token without echoing it and run the registration script:

   ```sh
   export DISCORD_APPLICATION_ID="your-application-id"
   read -s DISCORD_BOT_TOKEN
   export DISCORD_BOT_TOKEN
   node scripts/register-commands.mjs
   unset DISCORD_BOT_TOKEN DISCORD_APPLICATION_ID
   ```

   The bot token is read silently in the terminal and is not written to project files.

6. Keep the LINE webhook URL as `https://<worker-host>/line-webhook` and leave **Use webhook** enabled in LINE Developers Console.
7. Invite the Discord bot to each server where you want to pair channels.

`LEGACY_DISCORD_CHANNEL_ID` is only present to carry forward the original single-channel pairing. The Worker migrates that saved pairing on the next LINE webhook. Remove that variable from `wrangler.jsonc` before publishing a clean copy of the project.

## Implementation notes

- LINE webhook requests are validated with the channel secret; Discord interactions are validated with the application's Ed25519 public key.
- Pairings and temporary codes are stored in the bridge Durable Object. Pair codes expire after 10 minutes.
- The Discord Gateway subscribes to both server messages and direct messages. Users start a DM connection by opening a DM with the bot.
- `GET /` reports that the Worker is running.
