import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("LINE ↔ Discord bridge is running.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method !== "POST" || url.pathname !== "/line-webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN || !env.DISCORD_BOT_TOKEN || !env.DISCORD_CHANNEL_ID) {
      return new Response("Bridge secrets and Discord channel configuration are incomplete", { status: 503 });
    }

    const rawBody = await request.text();
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
    if (request.method !== "POST" || url.pathname !== "/line-event") {
      return new Response("Not found", { status: 404 });
    }
    const event = await request.json();
    console.log("Handling LINE event", { messageType: event.message?.type, sourceType: event.source?.type || "unknown" });
    await this.ensureConnected();
    await this.relayLineEvent(event);
    return new Response("OK");
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
          intents: 1 | 512 | 32768,
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
      if (message.channel_id !== this.env.DISCORD_CHANNEL_ID || message.author?.bot || message.author?.id === this.botUserId) {
        console.log("Ignored Discord message", { channelMatches: message.channel_id === this.env.DISCORD_CHANNEL_ID, isBot: Boolean(message.author?.bot) });
        return;
      }
      console.log("Forwarding Discord message", { attachmentCount: (message.attachments || []).length });
      await this.relayDiscordMessage(message);
    }
  }

  sendGateway(packet) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(packet));
  }

  async relayLineEvent(event) {
    if (event.webhookEventId) {
      const duplicate = await this.ctx.storage.get(`line-event:${event.webhookEventId}`);
      if (duplicate) return;
      await this.ctx.storage.put(`line-event:${event.webhookEventId}`, true);
    }
    const source = event.source || {};
    const lineTarget = source.groupId || source.roomId || source.userId;
    if (!lineTarget) return;
    const savedTarget = await this.ctx.storage.get("lineTarget");
    if (savedTarget && savedTarget !== lineTarget) {
      console.log("Ignored message from an unpaired LINE chat");
      return;
    }
    if (!savedTarget) {
      await this.ctx.storage.put("lineTarget", lineTarget);
      console.log("Paired LINE chat with Discord channel");
    }

    const message = event.message;
    const displayName = source.userId ? await this.getLineDisplayName(source.userId) : "LINE user";
    const parts = [`**${displayName} (LINE)**`];
    if (message.type === "text") parts.push(message.text || "");
    if (message.type === "file") parts.push(`File: ${message.fileName || "attachment"}`);
    const content = parts.join("\n").slice(0, 1900);

    if (["image", "video", "audio", "file"].includes(message.type)) {
      const media = await this.getLineContent(message.id);
      const filename = safeFilename(message.fileName || `line-${message.type}-${message.id}.${extensionFor(media.contentType)}`);
      await this.postDiscordMessage(content, { filename, blob: media.blob });
    } else {
      await this.postDiscordMessage(content);
    }
  }

  async getLineDisplayName(userId) {
    try {
      const response = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      if (response.ok) return (await response.json()).displayName || "LINE user";
    } catch { /* optional profile lookup */ }
    return "LINE user";
  }

  async getLineContent(messageId) {
    const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
      headers: { authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!response.ok) throw new Error(`LINE content download failed (${response.status})`);
    return { blob: await response.blob(), contentType: response.headers.get("content-type") || "application/octet-stream" };
  }

  async relayDiscordMessage(message) {
    const target = await this.ctx.storage.get("lineTarget");
    if (!target) {
      console.warn("Cannot forward Discord message: no LINE chat has been paired yet");
      return;
    }
    const label = message.member?.nick || message.author?.global_name || message.author?.username || "Discord user";
    const messages = [{ type: "text", text: `**${label} (Discord)**\n${message.content || "(attachment)"}`.slice(0, 5000) }];

    for (const attachment of message.attachments || []) {
      const isImage = (attachment.content_type || "").startsWith("image/") &&
        ["image/jpeg", "image/png"].includes(attachment.content_type) && attachment.size <= 10 * 1024 * 1024;
      if (isImage && messages.length < 5) {
        messages.push({ type: "image", originalContentUrl: attachment.url, previewImageUrl: attachment.url });
      } else if (messages.length < 5) {
        messages.push({ type: "text", text: `File: ${attachment.filename}\n${attachment.url}`.slice(0, 5000) });
      }
    }

    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to: target, messages: messages.slice(0, 5) }),
    });
    if (!response.ok) console.error("LINE push failed", response.status, await response.text());
    else console.log("Discord message sent to LINE");
  }

  async postDiscordMessage(content, file) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content }));
    if (file) form.append("files[0]", file.blob, file.filename);
    const response = await fetch(`https://discord.com/api/v10/channels/${this.env.DISCORD_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}` },
      body: form,
    });
    if (!response.ok) console.error("Discord post failed", response.status, await response.text());
    else console.log("LINE message sent to Discord");
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

function safeFilename(name) {
  return String(name).replace(/[\\/\0-\x1f\x7f]/g, "_").slice(0, 180) || "attachment";
}

function extensionFor(contentType) {
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "video/mp4": "mp4", "audio/m4a": "m4a", "audio/mp3": "mp3" };
  return extensions[contentType] || "bin";
}
