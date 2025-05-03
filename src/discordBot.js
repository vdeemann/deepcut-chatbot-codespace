// Import required modules
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
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

// Default messages and data structures
let queueData = { DJs: [], locked: false };
let currentSong = { songName: "Unknown", artist: "Unknown", djName: "Unknown", startTime: 0, roomName: "Unknown" };

// Helper function to safely get queue data
function getDJsArray() {
  // Check if queueData.DJs exists 
  if (!queueData || !queueData.DJs) {
    return [];
  }
  
  // If DJs is already an array, return it
  if (Array.isArray(queueData.DJs)) {
    return queueData.DJs;
  }
  
  // If DJs is a string, split it by commas and trim whitespace
  if (typeof queueData.DJs === 'string') {
    return queueData.DJs.split(',').map(dj => dj.trim());
  }
  
  // Fallback to empty array
  return [];
}

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
  
  try {
    // Parse JSON messages from each channel
    if (channel === "channel-1" && message.trim() !== "") {
      // DJ queue updates in the format: { DJs: [username list], locked: boolean }
      const queueInfo = JSON.parse(message);
      queueData = queueInfo;
      console.log("Updated DJ queue:", queueData);
    }
    
    if (channel === "channel-2" && message.trim() !== "") {
      // Current song information: { songName, artist, djName, startTime, roomName }
      const songInfo = JSON.parse(message);
      currentSong = songInfo;
      console.log("Updated song info:", currentSong);
    }
  } catch (e) {
    console.error(`Error parsing message from ${channel}:`, e);
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
    const djsArray = getDJsArray();
    message.reply(djsArray.length > 0 ? `DJ Queue: ${djsArray.join(", ")}` : "No DJs in queue.");
  }
  
  if (message.content === "!song") {
    if (currentSong && currentSong.songName && currentSong.artist) {
      message.reply(`Now playing: ${currentSong.songName} by ${currentSong.artist}`);
    } else {
      message.reply("No song information available.");
    }
  }
  
  // New !playing command
  if (message.content === "!playing") {
    // Get the current DJ and number of DJs on deck
    const currentDJ = currentSong.djName || "No DJ";
    const djsArray = getDJsArray();
    const djCount = djsArray.length;
    
    // Format current track information
    const trackInfo = currentSong.songName && currentSong.artist 
      ? `${currentSong.songName} by ${currentSong.artist}`
      : "No track information available";
    
    // Create an embed for better formatting
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('🎧 Now Playing')
      .setDescription(trackInfo)
      .addFields(
        { name: 'Current DJ', value: currentDJ, inline: true },
        { name: 'DJs on Deck', value: `${djCount} DJ${djCount !== 1 ? 's' : ''}`, inline: true },
        { name: 'Room', value: currentSong.roomName || "Unknown", inline: true }
      )
      .setFooter({ text: 'Radio Station Bot' })
      .setTimestamp();
    
    // If there are DJs in queue, add them to the embed
    if (djsArray.length > 0) {
      // Create a string with all DJs in queue (or just first few if many)
      const displayDJs = djsArray.length <= 10 
        ? djsArray.join('\n') 
        : djsArray.slice(0, 10).join('\n') + `\n... and ${djsArray.length - 10} more`;
      
      embed.addFields({ name: 'DJ Queue', value: displayDJs });
    }
    
    // Add queue status (locked/unlocked)
    embed.addFields({ 
      name: 'Queue Status', 
      value: queueData && queueData.locked ? '🔒 Locked' : '🔓 Open', 
      inline: true 
    });
    
    message.reply({ embeds: [embed] });
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);