import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();
const MAX_LINE_WEBHOOK_BYTES = 1 * 1024 * 1024;
const MAX_DISCORD_INTERACTION_BYTES = 64 * 1024;
const MAX_LINE_MEDIA_BYTES = 10 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("LINE ↔ Discord bridge is running.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/discord-interactions") {
      return handleDiscordInteraction(request, env);
    }

    if (url.pathname !== "/line-webhook") return new Response("Not found", { status: 404 });
    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN || !env.DISCORD_BOT_TOKEN) {
      return new Response("LINE and Discord secrets are incomplete", { status: 503 });
    }

    let rawBody;
    try {
      rawBody = await readBodyLimited(request, MAX_LINE_WEBHOOK_BYTES);
    } catch (error) {
      return new Response(error instanceof BodyTooLargeError ? "Request body too large" : "Could not read request body", {
        status: error instanceof BodyTooLargeError ? 413 : 400,
      });
    }
    const signature = request.headers.get("x-line-signature") || "";
    if (!(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
      console.warn("Rejected LINE webhook: invalid signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const bridge = env.BRIDGE.get(env.BRIDGE.idFromName("main"));
    console.log("Accepted LINE webhook", { eventCount: (body.events || []).length });
    for (const event of body.events || []) {
      if (event.type === "message" && event.message) {
        console.log("Forwarding LINE message event", { messageType: event.message.type, sourceType: event.source?.type || "unknown" });
        await bridge.fetch("https://bridge/line-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
      }
    }
    return new Response("OK", { status: 200 });
  },
};

async function handleDiscordInteraction(request, env) {
  if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_BOT_TOKEN) {
    return new Response("Discord interactions are not configured", { status: 503 });
  }
  let rawBody;
  try {
    rawBody = await readBodyLimited(request, MAX_DISCORD_INTERACTION_BYTES);
  } catch (error) {
    return new Response(error instanceof BodyTooLargeError ? "Request body too large" : "Could not read request body", {
      status: error instanceof BodyTooLargeError ? 413 : 400,
    });
  }
  const signature = request.headers.get("x-signature-ed25519") || "";
  const timestamp = request.headers.get("x-signature-timestamp") || "";
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 5 * 60) {
    return new Response("Expired interaction", { status: 401 });
  }
  if (!(await verifyDiscordSignature(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY))) {
    console.warn("Rejected Discord interaction: invalid signature");
    return new Response("Invalid signature", { status: 401 });
  }

  let interaction;
  try { interaction = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (interaction.type === 1) return Response.json({ type: 1 });
  if (interaction.type !== 2 || !interaction.channel_id) return Response.json({ type: 4, data: { content: "Use this command in a Discord server channel or a DM with the bot.", flags: 64 } });

  const command = interaction.data?.name;
  const channelId = interaction.channel_id;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const guildId = interaction.guild_id || null;
  if (guildId && !hasChannelAdminPermission(interaction.member?.permissions)) {
    return interactionResponse("You need Manage Channels permission to pair this server channel.");
  }

  const bridge = env.BRIDGE.get(env.BRIDGE.idFromName("main"));
  if (command === "pair") {
    const result = await bridge.fetch("https://bridge/pair-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId, guildId, ownerId: userId }),
    });
    const payload = await result.json();
    if (!result.ok) return interactionResponse(payload.error || "Could not create a pairing code.");
    return interactionResponse(`Pairing code: **${payload.code}**\nIn the LINE chat you want to connect, send: \`!pair ${payload.code}\`\nThis code expires in 10 minutes.`);
  }
  if (command === "unpair") {
    const result = await bridge.fetch("https://bridge/unpair-channel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId, guildId, userId }),
    });
    const payload = await result.json();
    return interactionResponse(payload.ok ? "That Discord channel has been unpaired." : "That channel is not paired.");
  }
  return interactionResponse("Unknown command.");
}

function hasChannelAdminPermission(permissions) {
  try {
    const allowed = (1n << 3n) | (1n << 4n) | (1n << 5n); // Administrator, Manage Channels, Manage Guild
    return (BigInt(permissions || "0") & allowed) !== 0n;
  } catch {
    return false;
  }
}

function interactionResponse(content) {
  return Response.json({ type: 4, data: { content, flags: 64 } });
}

export class DiscordGateway extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.socket = null;
    this.sequence = null;
    this.botUserId = null;
    this.heartbeatMs = 45_000;
    this.lastHeartbeatAck = true;
    this.reconnectDelayMs = 5_000;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/pair-code") {
      const body = await request.json();
      await this.migrateLegacyPair();
      const channelTarget = await this.getLineTargetForChannel(body.channelId);
      if (channelTarget) return Response.json({ error: "That Discord channel is already paired. Unpair it first." }, { status: 409 });
      const code = await this.createPairCode(body);
      return Response.json({ code });
    }
    if (url.pathname === "/unpair-channel") {
      const { channelId, guildId, userId } = await request.json();
      const lineTarget = await this.getLineTargetForChannel(channelId);
      if (!lineTarget) return Response.json({ ok: false });
      const metadata = await this.ctx.storage.get(`pairmeta:${channelId}`);
      if (guildId && metadata?.guildId && metadata.guildId !== guildId) return Response.json({ ok: false }, { status: 403 });
      if (!guildId && (!metadata || metadata.guildId || metadata.ownerId !== userId)) return Response.json({ ok: false }, { status: 403 });
      await this.ctx.storage.delete(`discord:${channelId}`);
      await this.ctx.storage.delete(`line:${lineTarget}`);
      await this.ctx.storage.delete(`pairmeta:${channelId}`);
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/line-event") return new Response("Not found", { status: 404 });
    const event = await request.json();
    console.log("Handling LINE event", { messageType: event.message?.type, sourceType: event.source?.type || "unknown" });
    await this.migrateLegacyPair();
    await this.ensureConnected();
    await this.relayLineEvent(event);
    return new Response("OK");
  }

  async createPairCode(details) {
    const random = new Uint8Array(6);
    for (let attempt = 0; attempt < 5; attempt++) {
      crypto.getRandomValues(random);
      const code = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
      const key = `pending:${code}`;
      if (!(await this.ctx.storage.get(key))) {
        await this.ctx.storage.put(key, { ...details, expiresAt: Date.now() + 10 * 60 * 1000 });
        return code;
      }
    }
    throw new Error("Could not generate a unique pairing code");
  }

  async getLineTargetForChannel(channelId) {
    const key = `discord:${channelId}`;
    let lineTarget = await this.ctx.storage.get(key);
    if (!lineTarget && this.env.LEGACY_DISCORD_CHANNEL_ID === channelId) {
      lineTarget = await this.ctx.storage.get("lineTarget");
      if (lineTarget) {
        await this.ctx.storage.put(key, lineTarget);
        await this.ctx.storage.put(`line:${lineTarget}`, channelId);
        await this.ctx.storage.delete("lineTarget");
      }
    }
    return lineTarget;
  }

  async migrateLegacyPair() {
    const oldTarget = await this.ctx.storage.get("lineTarget");
    if (!oldTarget || !this.env.LEGACY_DISCORD_CHANNEL_ID) return;
    const channelKey = `discord:${this.env.LEGACY_DISCORD_CHANNEL_ID}`;
    const lineKey = `line:${oldTarget}`;
    if (!(await this.ctx.storage.get(channelKey)) && !(await this.ctx.storage.get(lineKey))) {
      await this.ctx.storage.put(channelKey, oldTarget);
      await this.ctx.storage.put(lineKey, this.env.LEGACY_DISCORD_CHANNEL_ID);
    }
    await this.ctx.storage.delete("lineTarget");
  }

  async alarm() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.connectGateway();
      await this.ctx.storage.setAlarm(Date.now() + this.reconnectDelayMs);
      return;
    }
    if (!this.lastHeartbeatAck) {
      this.socket.close(4000, "Heartbeat acknowledgement timeout");
      await this.ctx.storage.setAlarm(Date.now() + this.reconnectDelayMs);
      return;
    }
    this.lastHeartbeatAck = false;
    this.sendGateway({ op: 1, d: this.sequence });
    await this.ctx.storage.setAlarm(Date.now() + this.heartbeatMs);
  }

  async ensureConnected() {
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) {
      await this.connectGateway();
    }
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + this.reconnectDelayMs);
    }
  }

  async connectGateway() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onGatewayMessage(event.data));
    socket.addEventListener("close", async () => {
      console.warn("Discord Gateway socket closed");
      this.socket = null;
      await this.ctx.storage.setAlarm(Date.now() + this.reconnectDelayMs);
    });
    socket.addEventListener("error", () => {
      console.error("Discord Gateway socket error");
      try { socket.close(); } catch { /* already closed */ }
    });
  }

  async onGatewayMessage(raw) {
    let packet;
    try { packet = JSON.parse(raw); } catch { return; }
    if (packet.s !== null && packet.s !== undefined) this.sequence = packet.s;

    if (packet.op === 10) {
      console.log("Discord Gateway connected; identifying bot");
      this.heartbeatMs = packet.d.heartbeat_interval;
      this.sendGateway({
        op: 2,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          intents: 1 | 512 | 4096 | 32768,
          properties: { os: "cloudflare-workers", browser: "line-discord-sync", device: "line-discord-sync" },
        },
      });
      this.lastHeartbeatAck = true;
      await this.ctx.storage.setAlarm(Date.now() + this.heartbeatMs);
      return;
    }
    if (packet.op === 11) {
      this.lastHeartbeatAck = true;
      return;
    }
    if (packet.op === 7 || packet.op === 9) {
      this.socket?.close(4000, "Discord requested reconnect");
      await this.ctx.storage.setAlarm(Date.now() + this.reconnectDelayMs);
      return;
    }
    if (packet.op !== 0) return;

    if (packet.t === "READY") {
      this.botUserId = packet.d.user?.id;
      console.log("Discord bot ready");
      return;
    }
    if (packet.t === "MESSAGE_CREATE") {
      const message = packet.d;
      if (message.author?.bot || message.author?.id === this.botUserId) return;
      await this.handleDiscordMessage(message);
    }
  }

  sendGateway(packet) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(packet));
  }

  async handleDiscordMessage(message) {
    const lineTarget = await this.getLineTargetForChannel(message.channel_id);
    if (!lineTarget) return;
    console.log("Forwarding Discord message", { attachmentCount: (message.attachments || []).length });
    await this.relayDiscordMessage(message, lineTarget);
  }

  async relayLineEvent(event) {
    await this.pruneLineEventRecords();
    const eventId = event.webhookEventId;
    if (eventId) {
      const duplicate = await this.ctx.storage.get(`line-event:${eventId}`);
      if (duplicate?.expiresAt > Date.now()) return;
      if (duplicate) await this.ctx.storage.delete(`line-event:${eventId}`);
    }
    const markProcessed = async () => {
      if (!eventId) return;
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      await this.ctx.storage.put(`line-event:${eventId}`, { expiresAt });
      await this.ctx.storage.put(`line-event-expiry:${expiresAt}:${eventId}`, eventId);
    };
    const source = event.source || {};
    const lineTarget = source.groupId || source.roomId || source.userId;
    if (!lineTarget) { await markProcessed(); return; }

    const message = event.message;
    const pairMatch = message.type === "text" && /^!pair\s+([a-f0-9]{12})$/i.exec(message.text?.trim() || "");
    if (pairMatch) {
      await this.completePairing(pairMatch[1].toUpperCase(), lineTarget, source.type);
      await markProcessed();
      return;
    }

    const channelId = await this.getDiscordChannelForLine(lineTarget);
    if (!channelId) {
      console.log("Ignored message from an unpaired LINE chat");
      await markProcessed();
      return;
    }
    const profile = source.userId ? await this.getLineProfile(source) : { displayName: "LINE user" };
    const replyToDiscordId = message.quotedMessageId
      ? await this.getDiscordMessageForLine(lineTarget, message.quotedMessageId)
      : null;
    if (message.quotedMessageId) {
      console.log("LINE reply mapping lookup", { found: Boolean(replyToDiscordId) });
    }
    const parts = [];
    if (message.type === "text" && message.text) parts.push(message.text);
    const content = parts.join("\n").slice(0, 1900);

    if (["image", "video", "audio", "file"].includes(message.type)) {
      let media;
      try {
        media = await this.getLineContent(message.id);
      } catch (error) {
        if (!String(error?.message || "").includes("exceeds the 10 MB relay limit")) throw error;
        const sent = await this.postDiscordLineMessage(channelId, "[LINE attachment skipped: larger than the 10 MB relay limit]", null, profile, replyToDiscordId);
        await this.saveReplyMapping(lineTarget, [message.id], sent?.id, message.quoteToken);
        await markProcessed();
        return;
      }
      const filename = safeFilename(message.fileName || `line-${message.type}-${message.id}.${extensionFor(media.contentType)}`);
      const sent = await this.postDiscordLineMessage(channelId, content, { filename, blob: media.blob }, profile, replyToDiscordId);
      await this.saveReplyMapping(lineTarget, [message.id], sent?.id, message.quoteToken);
    } else {
      const sent = await this.postDiscordLineMessage(channelId, content, null, profile, replyToDiscordId);
      await this.saveReplyMapping(lineTarget, [message.id], sent?.id, message.quoteToken);
    }
    await markProcessed();
  }

  async pruneLineEventRecords() {
    const now = Date.now();
    const entries = await this.ctx.storage.list({ prefix: "line-event-expiry:", limit: 100 });
    for (const [key, eventId] of entries) {
      const expiresAt = Number(key.split(":")[1]);
      if (!Number.isFinite(expiresAt) || expiresAt > now) break;
      const markerKey = `line-event:${eventId}`;
      const marker = await this.ctx.storage.get(markerKey);
      if (marker?.expiresAt <= now) await this.ctx.storage.delete(markerKey);
      await this.ctx.storage.delete(key);
    }
  }

  async getDiscordMessageForLine(lineTarget, lineMessageId) {
    return this.ctx.storage.get(`reply-line:${lineTarget}:${lineMessageId}`);
  }

  async getLineQuoteTokenForDiscord(lineTarget, discordMessageId) {
    const mapping = await this.ctx.storage.get(`reply-discord:${lineTarget}:${discordMessageId}`);
    return mapping?.quoteToken || null;
  }

  async saveReplyMapping(lineTarget, lineMessageIds, discordMessageId, quoteToken) {
    if (!discordMessageId) return;
    const lineIds = lineMessageIds.filter(Boolean);
    for (const lineMessageId of lineIds) {
      await this.ctx.storage.put(`reply-line:${lineTarget}:${lineMessageId}`, discordMessageId);
    }
    if (quoteToken) {
      await this.ctx.storage.put(`reply-discord:${lineTarget}:${discordMessageId}`, { quoteToken });
    }

    const createdAt = Date.now();
    const indexKey = `reply-map:${lineTarget}:${String(createdAt).padStart(13, "0")}:${discordMessageId}`;
    await this.ctx.storage.put(indexKey, { lineMessageIds: lineIds, discordMessageId, expiresAt: createdAt + 30 * 24 * 60 * 60 * 1000 });
    await this.pruneReplyMappings(lineTarget);
    console.log("Saved cross-platform reply mapping", { lineMessageCount: lineIds.length, hasQuoteToken: Boolean(quoteToken) });
  }

  async pruneReplyMappings(lineTarget) {
    const now = Date.now();
    const prefix = `reply-map:${lineTarget}:`;
    const entries = await this.ctx.storage.list({ prefix, limit: 1000 });
    const removeCount = Math.max(0, entries.size - 500);
    let removed = 0;
    for (const [key, record] of entries) {
      if (removed >= removeCount && record?.expiresAt > now) break;
      for (const lineMessageId of record?.lineMessageIds || []) {
        await this.ctx.storage.delete(`reply-line:${lineTarget}:${lineMessageId}`);
      }
      if (record?.discordMessageId) {
        await this.ctx.storage.delete(`reply-discord:${lineTarget}:${record.discordMessageId}`);
      }
      await this.ctx.storage.delete(key);
      removed++;
    }
  }

  async getDiscordChannelForLine(lineTarget) {
    let channelId = await this.ctx.storage.get(`line:${lineTarget}`);
    if (!channelId && this.env.LEGACY_DISCORD_CHANNEL_ID && (await this.ctx.storage.get("lineTarget")) === lineTarget) {
      channelId = this.env.LEGACY_DISCORD_CHANNEL_ID;
      await this.ctx.storage.put(`line:${lineTarget}`, channelId);
      await this.ctx.storage.put(`discord:${channelId}`, lineTarget);
      await this.ctx.storage.delete("lineTarget");
    }
    return channelId;
  }

  async completePairing(code, lineTarget, sourceType) {
    if (sourceType !== "group" && sourceType !== "room" && sourceType !== "user") {
      console.log("Ignored pairing code from an unsupported LINE chat");
      return;
    }
    const key = `pending:${code}`;
    const pending = await this.ctx.storage.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      await this.sendLineText(lineTarget, "That pairing code is invalid or expired. Run `/pair` in Discord to get a new one.");
      return;
    }
    const existingChannel = await this.ctx.storage.get(`line:${lineTarget}`);
    const existingTarget = await this.getLineTargetForChannel(pending.channelId);
    if (existingChannel || existingTarget) {
      await this.sendLineText(lineTarget, "This LINE group or Discord channel is already paired. Unpair it first, then try again.");
      return;
    }
    await this.ctx.storage.put(`discord:${pending.channelId}`, lineTarget);
    await this.ctx.storage.put(`line:${lineTarget}`, pending.channelId);
    await this.ctx.storage.put(`pairmeta:${pending.channelId}`, { guildId: pending.guildId || null, ownerId: pending.ownerId || null });
    await this.ctx.storage.delete(key);
    await this.sendLineText(lineTarget, "Connected to Discord. Messages and supported attachments will now sync to the paired channel.");
    await this.postDiscordMessage(pending.channelId, "This Discord channel is now paired with the LINE group.");
    console.log("Paired a LINE group and Discord channel");
  }

  async sendLineText(target, text) {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: target, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
    });
    if (!response.ok) console.error("LINE pairing response failed", response.status);
  }

  async getLineProfile(source) {
    try {
      const userId = encodeURIComponent(source.userId);
      let path = `/v2/bot/profile/${userId}`;
      if (source.type === "group" && source.groupId) {
        path = `/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${userId}`;
      } else if (source.type === "room" && source.roomId) {
        path = `/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${userId}`;
      }
      const response = await fetch(`https://api.line.me${path}`, {
        headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      if (response.ok) {
        const profile = await response.json();
        return { displayName: profile.displayName || "LINE user", pictureUrl: profile.pictureUrl || null };
      }
    } catch { /* optional profile lookup */ }
    return { displayName: "LINE user" };
  }

  async getLineContent(messageId) {
    const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!response.ok) throw new Error(`LINE content download failed (${response.status})`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_LINE_MEDIA_BYTES) {
      throw new Error("LINE attachment exceeds the 10 MB relay limit");
    }
    return {
      blob: await readResponseBlobLimited(response, MAX_LINE_MEDIA_BYTES),
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  }

  async relayDiscordMessage(message, target) {
    const label = message.member?.nick || message.author?.global_name || message.author?.username || "Discord user";
    const avatarUrl = discordAvatarUrl(message.author);
    const sender = makeLineSender(label, avatarUrl);
    const messages = [];
    if (message.content) messages.push({ type: "text", text: message.content.slice(0, 5000), sender });

    for (const attachment of message.attachments || []) {
      const isImage = (attachment.content_type || "").startsWith("image/") &&
        ["image/jpeg", "image/png"].includes(attachment.content_type) && attachment.size <= 10 * 1024 * 1024;
      if (isImage && messages.length < 5) {
        messages.push({ type: "image", originalContentUrl: attachment.url, previewImageUrl: attachment.url, sender });
      } else if (messages.length < 5) {
        messages.push({ type: "text", text: `File: ${attachment.filename}\n${attachment.url}`.slice(0, 5000), sender });
      }
    }
    if (messages.length === 0) messages.push({ type: "text", text: "(empty message)", sender });

    const quotedMessageId = message.message_reference?.message_id;
    const quoteToken = quotedMessageId ? await this.getLineQuoteTokenForDiscord(target, quotedMessageId) : null;
    if (quotedMessageId) {
      console.log("Discord reply mapping lookup", { found: Boolean(quoteToken) });
    }
    if (quoteToken) messages[0].quoteToken = quoteToken;

    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: target, messages: messages.slice(0, 5) }),
    });
    if (!response.ok) console.error("LINE push failed", response.status);
    else {
      const result = await response.json();
      const sentMessages = result.sentMessages || [];
      const lineMessageIds = sentMessages.map((sent) => sent.id).filter(Boolean);
      const lineQuoteToken = sentMessages.find((sent) => sent.quoteToken)?.quoteToken || null;
      await this.saveReplyMapping(target, lineMessageIds, message.id, lineQuoteToken);
      console.log("Discord message sent to LINE");
    }
  }

  async postDiscordLineMessage(channelId, content, file, profile, replyToMessageId = null) {
    const prefix = `**${profile.displayName || "LINE user"} (LINE)**`;
    const fallbackContent = content ? `${prefix}\n${content}` : prefix;
    // Discord's incoming webhook API doesn't support message_reference; use the bot API for native replies.
    if (replyToMessageId) {
      return this.postDiscordMessage(channelId, content, file, replyToMessageId, profile);
    }

    const metadata = await this.ctx.storage.get(`pairmeta:${channelId}`);
    if (await this.isGuildChannel(channelId, metadata)) {
      const webhook = await this.getOrCreateLineWebhook(channelId);
      if (webhook) {
        const username = `${profile.displayName || "LINE user"} (LINE)`.slice(0, 80);
        const sent = await this.executeLineWebhook(webhook, content, file, username, profile.pictureUrl);
        if (sent) return sent;
      }
    }

    return this.postDiscordMessage(channelId, fallbackContent, file, replyToMessageId);
  }

  async isGuildChannel(channelId, metadata) {
    if (metadata?.guildId) return true;
    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
        headers: { authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
      });
      if (!response.ok) {
        console.warn("Could not check Discord channel type for LINE webhook", response.status);
        return false;
      }
      const channel = await response.json();
      if (!channel.guild_id) return false;
      await this.ctx.storage.put(`pairmeta:${channelId}`, { ...metadata, guildId: channel.guild_id });
      return true;
    } catch (error) {
      console.warn("Could not check Discord channel type for LINE webhook", error?.message || "request failed");
      return false;
    }
  }

  async getOrCreateLineWebhook(channelId) {
    const key = `line-webhook:${channelId}`;
    const saved = await this.ctx.storage.get(key);
    if (saved?.id && saved?.token) return saved;

    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, {
        method: "POST",
        headers: {
          authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "LINE Bridge" }),
      });
      if (!response.ok) {
        console.warn("Could not create LINE relay webhook; using bot messages instead", response.status);
        return null;
      }
      const webhook = await response.json();
      if (!webhook.id || !webhook.token) return null;
      const result = { id: webhook.id, token: webhook.token };
      await this.ctx.storage.put(key, result);
      return result;
    } catch (error) {
      console.warn("Could not create LINE relay webhook; using bot messages instead", error?.message || "request failed");
      return null;
    }
  }

  async executeLineWebhook(webhook, content, file, username, avatarUrl) {
    try {
      const form = new FormData();
      const payload = { username, content, allowed_mentions: { parse: [] } };
      if (avatarUrl?.startsWith("https://")) payload.avatar_url = avatarUrl;
      form.append("payload_json", JSON.stringify(payload));
      if (file) form.append("files[0]", file.blob, file.filename);
      const response = await fetch(`https://discord.com/api/webhooks/${webhook.id}/${webhook.token}?wait=true`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        console.warn("Discord LINE webhook send failed; using bot message instead", response.status);
        return false;
      }
      return await response.json();
    } catch (error) {
      console.warn("Discord LINE webhook send failed; using bot message instead", error?.message || "request failed");
      return false;
    }
  }

  async postDiscordMessage(channelId, content, file, replyToMessageId = null, lineProfile = null) {
    const send = async (referenceId) => {
      const form = new FormData();
      const payload = { content, allowed_mentions: { parse: [] } };
      if (lineProfile) {
        const author = { name: `${lineProfile.displayName || "LINE user"} (LINE)`.slice(0, 256) };
        if (lineProfile.pictureUrl?.startsWith("https://")) author.icon_url = lineProfile.pictureUrl;
        payload.embeds = [{ author }];
      }
      if (referenceId) payload.message_reference = { message_id: referenceId, fail_if_not_exists: false };
      form.append("payload_json", JSON.stringify(payload));
      if (file) form.append("files[0]", file.blob, file.filename);
      return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
        body: form,
      });
    };
    let response = await send(replyToMessageId);
    if (!response.ok && replyToMessageId) {
      console.warn("Discord rejected reply reference; retrying message without reply context", response.status);
      response = await send(null);
    }
    if (!response.ok) {
      console.error("Discord post failed", response.status);
      return null;
    }
    console.log("LINE message sent to Discord");
    return response.json();
  }
}

async function verifyLineSignature(body, receivedSignature, secret) {
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
    const expected = btoa(String.fromCharCode(...digest));
    if (expected.length !== receivedSignature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ receivedSignature.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

async function verifyDiscordSignature(body, signatureHex, timestamp, publicKeyHex) {
  try {
    if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, signature, encoder.encode(timestamp + body));
  } catch {
    return false;
  }
}

class BodyTooLargeError extends Error {}

async function readBodyLimited(request, maxBytes) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readResponseBlobLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return new Blob([]);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("LINE attachment exceeds the 10 MB relay limit");
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function discordAvatarUrl(user) {
  if (!user?.id) return null;
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256&format=png`;
  }
  try {
    const defaultAvatar = (BigInt(user.id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
  } catch {
    return null;
  }
}

function makeLineSender(name, iconUrl) {
  const safeName = String(name || "Discord user").replace(/[\r\n]/g, " ").slice(0, 20);
  const sender = { name: safeName || "Discord user" };
  if (iconUrl?.startsWith("https://")) sender.iconUrl = iconUrl;
  return sender;
}

function safeFilename(name) {
  return String(name).replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 180) || "attachment";
}

function extensionFor(contentType) {
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "audio/m4a": "m4a", "audio/mp3": "mp3" };
  return extensions[contentType] || "bin";
}
