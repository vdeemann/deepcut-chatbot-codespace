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
let queueMessage = "No queue information available yet."; // Default message
let songMessage = "No song information available yet."; // Default message

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
  // Only update messages if they're not empty
  if (channel.includes("channel-1") && message.trim() !== "") {
    queueMessage = message;
  }
  if (channel.includes("channel-2") && message.trim() !== "") {
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
    message.reply(queueMessage || "No queue information available.");
  }

  if (message.content === "!song") {
    message.reply(songMessage || "No song information available.");
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);