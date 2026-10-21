const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !botToken) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in your environment, then run this script again.");
  process.exit(1);
}

const commands = [
  {
    name: "pair",
    description: "Pair a Discord channel with a LINE group",
    integration_types: [0],
    contexts: [0, 1],
  },
  {
    name: "unpair",
    description: "Disconnect a Discord channel from its LINE group",
    integration_types: [0],
    contexts: [0, 1],
  },
];

for (const command of commands) {
  const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/commands`, {
    method: "POST",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    console.error(`Could not register /${command.name}:`, response.status, await response.text());
    process.exitCode = 1;
    break;
  }
  console.log(`Registered /${command.name}`);
}
