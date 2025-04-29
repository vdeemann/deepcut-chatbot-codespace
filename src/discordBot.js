// Import required modules
const { Client, GatewayIntentBits } = require("discord.js");
const Redis = require("ioredis");

// Set up Discord client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Connect to Redis
const redis = new Redis(process.env.UPSTASH_REDIS_AUTH);
let queueMessage = "";
let songMessage = "";

// Subscribe to Redis channels
redis.subscribe("channel-1", "channel-2", (err, count) => {
  if (err) {
    console.error("Failed to subscribe:", err.message);
  } else {
    console.log(`Subscribed to ${count} channels successfully!`);
  }
});

// Handle incoming Redis messages
redis.on("message", (channel, message) => {
  console.log(`Received ${message} from ${channel}`);
  if (channel.includes("channel-1")) {
    queueMessage = message;
  }
  if (channel.includes("channel-2")) {
    songMessage = message;
  }
});

// Log when Discord bot is ready
client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// Handle Discord messages
client.on("messageCreate", async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;

  // Respond to !queue command with data from Redis
  if (message.content === "!queue") {
    message.reply(queueMessage);
  }

  // TODO: Fix to show the recent last song
  // if (message.content === "!song") {
  //   message.reply(songMessage);
  // }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
