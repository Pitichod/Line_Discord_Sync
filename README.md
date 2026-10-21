# LINE ↔ Discord Sync

A two-way messaging bridge built with Cloudflare Workers. Pair LINE chats with Discord channels or direct messages, then relay text and supported attachments between them.

Made with ❤️ by **Pitichod**.

Each deployment uses one LINE Official Account and one Discord bot. Pair chats independently with `/pair`.

## Project status and disclaimer

This is my first time sharing a project publicly. I originally built it for personal use because I couldn't find a tool like this when I searched—or perhaps I just missed one. Please be kind if you spot a mistake, and feel free to contact me at [ninepitichod@gmail.com](mailto:ninepitichod@gmail.com). I may keep developing this project, or it may stay as it is. It is provided as-is, without a promise of support, uptime, or future updates. If you use the hosted bot or deploy this code, you accept the risks and are responsible for your own configuration and data. Thanks for understanding.

## Try the hosted bot

You can try the bot and LINE Official Account I operate without creating your own bot or deploying a Worker:

- [Invite the Discord bot](https://discord.com/oauth2/authorize?client_id=1562370057760145418&scope=bot%20applications.commands&permissions=536972288)
- [Add the LINE Official Account](https://line.me/R/ti/p/%40649iflwh) (LINE ID: `@649iflwh`)

To connect your chats:

1. Invite the Discord bot to your server. The person installing it needs permission to manage the server.
2. Add the LINE Official Account as a friend. For a LINE group, add the Official Account to that group and allow it to join group chats in LINE Official Account settings.
3. In the Discord channel you want to connect, run `/pair`. The person using `/pair` needs **Manage Channels**, **Manage Server**, or **Administrator** permission.
4. In the LINE one-to-one chat or group you want to connect, send `!pair CODE` using the code from Discord. The code expires after 10 minutes.

Each Discord channel or DM pairs with one LINE chat. Messages and supported attachments in paired chats pass through the Worker and the LINE and Discord bot accounts I operate. The bridge stores pairing details, temporary pairing codes, webhook credentials, and message IDs used for reply linking; it does not intentionally store message text or attachment contents. Reply-link records are kept for up to 30 days and are deleted when you run `/unpair`. See the [Privacy Notice](PRIVACY.md) for details. Shared usage consumes the service's provider quotas, so access may be limited or stopped if needed. Only pair chats whose members understand that messages may be relayed, and do not use the shared setup for sensitive conversations. The hosted service may be unavailable or change without notice.

## Features

- Relay LINE text, photos, videos, audio, and files to Discord.
- Relay Discord text and attachments to LINE. JPEG and PNG files up to 10 MB are sent as LINE images; other Discord files are shared as links.
- Show LINE profile names and photos in Discord server channels using a Discord webhook, when the bot has **Manage Webhooks** permission.
- Show Discord names and profile photos as LINE message senders. LINE adds `from '<Official Account name>'` to customized sender names; this attribution is added by LINE and can't be disabled.
- Pair and unpair chats with `/pair`, `!pair CODE`, and `/unpair`.
- Pair multiple LINE chats and Discord channels to one deployment.
- Preserve reply context between platforms when the original relayed message is still mapped.

## How pairing works

1. Run `/pair` in the Discord channel or DM you want to connect. The bot returns a one-time 12-character code that expires after 10 minutes.
2. In the LINE group or one-to-one chat with your Official Account, send `!pair CODE`.
3. Messages now relay between those chats. Repeat to add more pairs.
4. Run `/unpair` in the Discord channel or DM to remove its pairing.

In a Discord server, `/pair` requires **Manage Channels**, **Manage Server**, or **Administrator** permission. For a DM pairing, only the user who created the pairing can unpair it.

## Requirements

- Node.js and npm
- A Cloudflare account with Workers and Durable Objects enabled
- A Discord application and bot
- A LINE Official Account with a Messaging API channel

The Discord bot needs **View Channel**, **Read Message History**, **Send Messages**, **Attach Files**, and **Manage Webhooks** in each paired server channel. Without Manage Webhooks, regular LINE messages use the bot identity instead of showing the LINE profile as the author. Replies from LINE use the bot identity so Discord can render a native reply. Discord shows the bot name as the author, with the LINE name and profile picture above the reply text in an embed. Discord DM pairings also use the bot's own identity.

For Discord message relaying, enable the **Message Content Intent** in the Discord Developer Portal. For LINE groups, enable **Allow bot to join group chats** and add the Official Account to each group.

Before offering the hosted bot publicly, publish [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) at public URLs and enter them as the application's Privacy Policy URL and Terms of Service URL in the Discord Developer Portal. Discord requires an application privacy policy describing data collection, use, sharing, and deletion requests. Discord also announced that apps reaching 10,000 users need review for continued access to message content, with annual reapplication; confirm the current requirements in [Discord's developer announcement](https://discord.com/blog/updated-requirements-to-how-apps-access-data-in-servers).

## Set up your own deployment

For a self-hosted setup, create your own Discord application/bot and LINE Official Account/Messaging API channel. Use your own credentials; never copy credentials from the hosted setup.

- [Create a Discord application](https://discord.com/developers/applications). Under **Bot**, create the bot, enable **Message Content Intent**, and copy its bot token. Copy the application's **Public Key** from **General Information**.
- [Create a LINE Official Account and enable the Messaging API](https://developers.line.biz/en/docs/messaging-api/getting-started/). Copy the channel secret and issue a channel access token. For group chats, allow the Official Account to join group chats.

### 1. Install dependencies and authenticate Wrangler

```sh
npm install
npx wrangler login
```

### 2. Add credentials as Cloudflare secrets

Run each command and enter the value when Wrangler prompts you:

```sh
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put DISCORD_BOT_TOKEN
```

Do not put these tokens in `wrangler.jsonc`, `.dev.vars`, or committed files. Cloudflare documents encrypted Worker secrets in its [Workers secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/).

### 3. Set the Discord application public key

In `wrangler.jsonc`, set `DISCORD_PUBLIC_KEY` to the **Public Key** shown in your Discord application's General Information. This is not the bot token. The legacy channel binding has been removed from the sample configuration; the code only uses it if you explicitly add it back for a one-time migration.

### 4. Deploy the Worker

```sh
npx wrangler deploy
```

Copy the Worker URL printed by Wrangler. It will look like `https://<worker-name>.<your-subdomain>.workers.dev`.

### 5. Configure Discord interactions and commands

In the Discord Developer Portal, set **Interactions Endpoint URL** to:

```text
https://<worker-host>/discord-interactions
```

Register the global `/pair` and `/unpair` commands. Set the application ID, then enter your bot token silently in the terminal:

```sh
export DISCORD_APPLICATION_ID="your-application-id"
read -s DISCORD_BOT_TOKEN
export DISCORD_BOT_TOKEN
npm run register-commands
unset DISCORD_APPLICATION_ID DISCORD_BOT_TOKEN
```

The registration script sends the token to Discord's API for authentication; it does not write it to project files.

### 6. Configure the LINE webhook

In LINE Developers Console, set the Messaging API webhook URL to:

```text
https://<worker-host>/line-webhook
```

Enable **Use webhook**. LINE describes webhook setup in its [Messaging API bot guide](https://developers.line.biz/en/docs/messaging-api/building-bot/).

### 7. Install and pair

Invite the Discord bot to each server and grant the channel permissions listed above. Open a DM with the bot before using `/pair` in a Discord DM. Then follow the pairing steps above.

## Local development and logs

Start a local Worker with:

```sh
npx wrangler dev
```

View deployed Worker logs with:

```sh
npx wrangler tail
```

`GET /` returns a basic health response. Pairings, temporary codes, and webhook credentials are stored in the Durable Object. Pair codes expire after 10 minutes.

## Known limitations

- LINE has no general Messaging API message type for sending arbitrary files. Images from Discord are sent as LINE images when they are JPEG or PNG and no larger than 10 MB; other files are sent as links, which may expire.
- LINE's customized sender display always includes `from '<Official Account name>'`. This is LINE platform behavior, not text added by this Worker. See [Customize icon and display name](https://developers.line.biz/en/docs/messaging-api/icon-nickname-switch/).
- Discord webhook identities are used for regular LINE messages in server channels. Replies from LINE use the bot identity for native reply support, so Discord displays LineSync as the author; the LINE name and profile picture appear above the reply text in an embed. Discord DM pairings use the bot's own identity.
- The bridge forwards messages and attachments between paired chats. Pair only chats whose members understand that their messages may be relayed to the other platform.
- LINE attachments larger than 10 MB are skipped to keep Worker memory use bounded. The bridge posts a notice in Discord instead.
- LINE text relayed to Discord cannot trigger Discord mentions such as `@everyone`.
- Reply links are kept for the latest 500 relayed messages per paired chat, up to 30 days. LINE only provides quote tokens for supported message types, so some replies may arrive without a native quote preview.

## License and attribution

Copyright belongs to **Pitichod**. Made with ❤️ by **Pitichod**. This project is provided under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, copy, modify, and share it for noncommercial purposes without asking first, as long as you include the license and keep the required copyright notice. The license restricts commercial use, with specific exceptions described in its full terms for certain charitable, educational, research, public safety/health, environmental, and government institutions. This is source-available software with a noncommercial restriction, not an OSI-approved open-source license. This is not legal advice; if an absolute ban on every revenue-generating use is essential, the standard license's stated exceptions mean you should get a custom license reviewed by a lawyer before publishing.

The license applies to this project's original code. Cloudflare, Discord, LINE, Wrangler, and other third-party services or packages remain under their own terms and licenses.

## Before publishing or deploying

- Never commit `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `DISCORD_BOT_TOKEN`, or webhook URLs containing tokens. Store credentials as Cloudflare secrets. `.dev.vars` and `.env` are ignored by Git.
- `DISCORD_PUBLIC_KEY` is a public verification key, not a secret, but you must set it to the key for your own Discord application when self-hosting.
- Check the full Git history before making the repository public. Removing a credential from the latest file does not remove it from earlier commits. If a credential was ever committed, revoke/rotate it before publishing.
- The hosted invite links above point to Pitichod's own bot and LINE Official Account. Self-hosters must create and configure their own accounts and credentials.

## Architecture

- `src/index.js` handles the LINE webhook, Discord interactions, and Durable Object logic.
- The `DiscordGateway` Durable Object keeps the Discord Gateway connection and pairing state.
- `scripts/register-commands.mjs` registers the Discord slash commands.
- `wrangler.jsonc` configures the Worker and Durable Object binding.

Cloudflare's [Durable Objects guide](https://developers.cloudflare.com/durable-objects/get-started/) explains the stateful coordination model used by the bridge.
