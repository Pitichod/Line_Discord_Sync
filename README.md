# LINE ↔ Discord Sync

A two-way messaging bridge built with Cloudflare Workers. Pair LINE chats with Discord channels or direct messages, then relay text and supported attachments between them.

Each deployment uses one LINE Official Account and one Discord bot. Pair chats independently with `/pair`.

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

The Discord bot needs View Channel, **Read Message History**, Send Messages, Attach Files, and **Manage Webhooks** in each paired server channel. Without Manage Webhooks, regular LINE messages use a bot message in Discord instead of showing the LINE profile as the message author. Replies from LINE use the bot identity so Discord can render a native reply. Discord shows the bot name (LineSync) as the message author, with the LINE name and profile picture above the reply text in an embed. Discord DM pairings also use the bot's own identity.

For Discord message relaying, enable the **Message Content Intent** in the Discord Developer Portal. For LINE groups, enable **Allow bot to join group chats** and add the Official Account to each group.

## Set up your own deployment

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

## Preparing this repository for public sharing

Before making this particular repository public:

1. `DISCORD_PUBLIC_KEY` is a public verification key, not a credential. Set it to your own application's key before deployment.
2. Check the full Git history too. Removing a value from the latest file does not remove copies in earlier commits. If this repository has already been pushed, prepare a clean public history before publishing it.
3. Confirm no Discord bot token, LINE channel secret, LINE access token, or other credential was committed. Keep them in Cloudflare secrets and local ignored files.
4. Add a `LICENSE` file if you want others to have permission to reuse or modify the project. No license is included yet.

## Architecture

- `src/index.js` handles the LINE webhook, Discord interactions, and Durable Object logic.
- The `DiscordGateway` Durable Object keeps the Discord Gateway connection and pairing state.
- `scripts/register-commands.mjs` registers the Discord slash commands.
- `wrangler.jsonc` configures the Worker and Durable Object binding.

Cloudflare's [Durable Objects guide](https://developers.cloudflare.com/durable-objects/get-started/) explains the stateful coordination model used by the bridge.
