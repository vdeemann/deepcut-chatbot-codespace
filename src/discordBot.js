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

// Create two separate Redis clients
// One for pub/sub operations and another for regular commands
const redisSub = new Redis(process.env.UPSTASH_REDIS_AUTH); // For subscribing
const redisClient = new Redis(process.env.UPSTASH_REDIS_AUTH); // For regular commands

// Default messages and data structures
let queueData = { DJs: [], locked: false };
let currentSong = { songName: "Unknown", artist: "Unknown", djName: "Unknown", startTime: 0, roomName: "Unknown" };

// Time slots available for scheduling (24-hour format)
const availableTimeSlots = [9, 10, 11, 13, 14, 15, 16]; // 9am, 10am, 11am, 1pm, 2pm, 3pm, 4pm

// Common timezone offsets (simplified for this example)
const timeOffsets = {
  'America/New_York': -4, // EDT
  'America/Chicago': -5, // CDT
  'America/Denver': -6, // MDT
  'America/Los_Angeles': -7, // PDT
  'Europe/London': 1, // BST
  'Europe/Paris': 2, // CEST
  'Asia/Tokyo': 9, // JST
  'Australia/Sydney': 10, // AEST
  // Add more common timezones as needed
};

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
  
  // If DJs is a string, check for empty queue indicators
  if (typeof queueData.DJs === 'string') {
    const djString = queueData.DJs.trim();
    
    // Handle empty queue cases
    if (djString === "" || djString === "Empty" || djString === "Queue is empty") {
      return [];
    }
    
    // Split by commas and trim whitespace, filter out empty strings
    return djString.split(',').map(dj => dj.trim()).filter(dj => dj !== "");
  }
  
  // Fallback to empty array
  return [];
}

// NEW: Function to request current room info from turntable bot
async function requestCurrentRoomInfo() {
  try {
    // Send a request to the turntable bot to get fresh room info
    await redisClient.publish("bot-commands", JSON.stringify({
      command: "getCurrentRoomInfo",
      timestamp: Date.now()
    }));
    
    console.log("Requested current room info from turntable bot");
    return true;
  } catch (error) {
    console.error("Error requesting room info:", error);
    return false;
  }
}

// NEW: Function to check if turntable bot is online
async function checkTurntableBotStatus() {
  try {
    // Send a ping command to check if the bot is responding
    await redisClient.publish("bot-commands", JSON.stringify({
      command: "ping",
      timestamp: Date.now()
    }));
    
    console.log("Sent ping to turntable bot");
    
    // Wait for a pong response with timeout
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log("Turntable bot ping timeout - bot appears offline");
        resolve(false);
      }, 3000); // 3 second timeout
      
      // Listen for pong response
      const pingListener = (channel, message) => {
        if (channel === "bot-commands") {
          try {
            const data = JSON.parse(message);
            if (data.command === "pong") {
              console.log("Received pong from turntable bot - bot is online");
              clearTimeout(timeout);
              redisSub.off("message", pingListener);
              resolve(true);
            }
          } catch (e) {
            // Ignore parse errors for other messages
          }
        }
      };
      
      redisSub.on("message", pingListener);
    });
  } catch (error) {
    console.error("Error checking turntable bot status:", error);
    return false;
  }
}

// NEW: Function to wait for updated data with timeout
function waitForUpdatedData(originalTimestamp, timeout = 5000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let checkCount = 0;
    
    const checkForUpdate = () => {
      checkCount++;
      console.log(`Check #${checkCount}: Current timestamp ${currentSong.startTime}, Original timestamp ${originalTimestamp}`);
      
      // Check if we received new data (timestamp is newer OR song data changed)
      if (currentSong.startTime > originalTimestamp || 
          (currentSong.djName && currentSong.djName !== "Unknown") ||
          (currentSong.songName && currentSong.songName !== "Unknown")) {
        console.log("Updated data detected!");
        resolve(true);
        return;
      }
      
      // Check if timeout reached
      if (Date.now() - startTime > timeout) {
        console.log("Timeout reached, no updated data received");
        resolve(false);
        return;
      }
      
      // Check again in 200ms
      setTimeout(checkForUpdate, 200);
    };
    
    // Start checking after a brief delay to allow message processing
    setTimeout(checkForUpdate, 100);
  });
}

// Helper function to get or initialize schedule for a first Friday
async function getScheduleForFirstFriday(dateStr) {
  const key = `firstfriday:${dateStr}`;
  let schedule = await redisClient.get(key);
  
  if (!schedule) {
    // Initialize empty schedule
    const emptySchedule = {
      date: dateStr,
      slots: {}
    };
    
    // Initialize all available time slots as empty
    availableTimeSlots.forEach(hour => {
      emptySchedule.slots[hour] = null;
    });
    
    await redisClient.set(key, JSON.stringify(emptySchedule));
    return emptySchedule;
  }
  
  return JSON.parse(schedule);
}

// Helper function to save first Friday schedule
async function saveFirstFridaySchedule(schedule) {
  const key = `firstfriday:${schedule.date}`;
  await redisClient.set(key, JSON.stringify(schedule));
}

// Helper function to format time slots for display
function formatTimeSlot(hour) {
  // Convert 24-hour format to 12-hour format with am/pm
  const hour12 = hour % 12 || 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  return `${hour12}${ampm}`;
}

// Helper function to format date for display
function formatDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day); // Adjust month (0-indexed)
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString('en-US', options);
}

// Helper function to get a specific first Friday by year and month
function getFirstFridayOfMonth(year, month) {
  // Start with the 1st of the specified month
  let date = new Date(year, month - 1, 1); // JS months are 0-indexed
  
  // Find the first Friday
  while (date.getDay() !== 5) {
    date.setDate(date.getDate() + 1);
  }
  
  // Format to YYYY-MM-DD
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Helper function to get the next first Friday of a month
function getNextFirstFriday() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-indexed
  
  // Start with the current month
  let targetMonth = currentMonth;
  let targetYear = currentYear;
  
  // Get first Friday of current month
  let firstFriday = new Date(currentYear, currentMonth, 1);
  while (firstFriday.getDay() !== 5) {
    firstFriday.setDate(firstFriday.getDate() + 1);
  }
  
  // If we've already passed the first Friday of this month, move to next month
  if (now > firstFriday) {
    targetMonth = currentMonth + 1;
    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear++;
    }
  }
  
  // Get the first Friday of target month
  return getFirstFridayOfMonth(targetYear, targetMonth + 1); // +1 because getFirstFridayOfMonth expects 1-indexed months
}

// Function to get upcoming first Fridays
function getUpcomingFirstFridays(count = 6) {
  const fridays = [];
  let nextDate = getNextFirstFriday();
  
  for (let i = 0; i < count; i++) {
    fridays.push(nextDate);
    
    // Move to the next month
    const [year, month, day] = nextDate.split('-').map(Number);
    
    let nextYear = year;
    let nextMonth = month + 1;
    
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear++;
    }
    
    nextDate = getFirstFridayOfMonth(nextYear, nextMonth);
  }
  
  return fridays;
}

// Function to check if a DJ can be scheduled at a specific time
function canScheduleDJ(djName, djTimezone, date, hour, existingSchedule) {
  // Convert the slot time to the DJ's local time
  const timezoneOffset = timeOffsets[djTimezone] || 0;
  
  // Calculate DJ's local hour
  let djLocalHour = (hour + timezoneOffset) % 24;
  if (djLocalHour < 0) djLocalHour += 24;
  
  // Constraint 1: Don't schedule during unreasonable hours in DJ's timezone
  if (djLocalHour < 7 || djLocalHour > 23) {
    return false; // Too early or too late in DJ's local time
  }
  
  // Constraint 2: Don't schedule the same DJ twice in the same first Friday
  for (const slot in existingSchedule.slots) {
    if (existingSchedule.slots[slot] && existingSchedule.slots[slot].dj === djName) {
      return false;
    }
  }
  
  // Constraint 3: Check if the slot is available
  if (existingSchedule.slots[hour]) {
    return false;
  }
  
  return true;
}

// Helper function to display DJ Event schedule
async function displayFirstFridaySchedule(message, date) {
  try {
    // Get schedule for the requested first Friday
    const schedule = await getScheduleForFirstFriday(date);
    
    // Create a formatted display of the schedule
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`🎧 DJ Event Schedule - ${formatDate(date)}`);
    
    // Build the schedule display
    let scheduleDisplay = '';
    
    availableTimeSlots.forEach(hour => {
      if (schedule.slots[hour]) {
        // Slot is booked
        scheduleDisplay += `* ${formatTimeSlot(hour)} - ${schedule.slots[hour].dj} (${schedule.slots[hour].timezone})\n`;
      } else {
        // Slot is free
        const slotIndex = availableTimeSlots.indexOf(hour) + 1;
        scheduleDisplay += `[${slotIndex}] ${formatTimeSlot(hour)} is free\n`;
      }
    });
    
    embed.setDescription(scheduleDisplay);
    
    // Add signup instructions
    embed.addFields({
      name: 'How to Sign Up',
      value: 'Use `!signup <slot_number> <your_timezone>` to claim a time slot\nExample: `!signup 2 America/New_York`'
    });
    
    message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Error displaying DJ Event times:', error);
    message.reply('Sorry, there was an error retrieving the schedule.');
  }
}

// Subscribe to Redis channels
redisSub.subscribe("channel-1", "channel-2", "bot-commands", (err, count) => {
  if (err) {
    console.error("Failed to subscribe:", err.message);
  } else {
    console.log(`Subscribed to ${count} channels successfully!`);
  }
});

// Handle incoming Redis messages
redisSub.on("message", (channel, message) => {
  console.log(`Received message from ${channel}: ${message}`);
  
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
      console.log("Received song info:", songInfo);
      currentSong = songInfo;
      console.log("Updated current song:", currentSong);
    }
    
    // NEW: Handle bot command responses
    if (channel === "bot-commands" && message.trim() !== "") {
      const commandData = JSON.parse(message);
      console.log("Received bot command response:", commandData);
    }
  } catch (e) {
    console.error(`Error parsing message from ${channel}:`, e);
    console.log("Raw message that failed to parse:", message);
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
  
  // MODIFIED: Handle !playing command with real-time data request and bot status check
  if (message.content === "!playing") {
    try {
      // Send "typing" indicator to show bot is working
      await message.channel.sendTyping();
      
      console.log("Processing !playing command");
      
      // First, check if the turntable bot is online
      console.log("Checking turntable bot status...");
      const botIsOnline = await checkTurntableBotStatus();
      
      if (!botIsOnline) {
        // Bot is offline, send appropriate message
        const embed = new EmbedBuilder()
          .setColor(0xFF0000) // Red color for offline
          .setTitle('🤖 Turntable Bot Offline')
          .setDescription('The turntable bot is currently offline or not responding.')
          .addFields(
            { name: 'Status', value: '🔴 Offline', inline: true },
            { name: 'What does this mean?', value: 'The bot that manages the turntable room is not running or has lost connection.', inline: false },
            { name: 'What can you do?', value: '• Check back later\n• Contact an admin if the issue persists\n• Visit the turntable room directly for current info', inline: false }
          )
          .setFooter({ text: 'Try again in a few minutes' });
        
        message.reply({ embeds: [embed] });
        return;
      }
      
      // Bot is online, proceed with normal flow
      console.log("Turntable bot is online, requesting fresh data");
      
      // Store the current timestamp to detect new data
      const originalTimestamp = currentSong.startTime || 0;
      console.log("Original timestamp:", originalTimestamp);
      
      // Request fresh data from the turntable bot
      const requestSent = await requestCurrentRoomInfo();
      console.log("Room info request sent:", requestSent);
      
      if (requestSent) {
        // Wait for updated data (with 5 second timeout)
        console.log("Waiting for updated data...");
        const dataUpdated = await waitForUpdatedData(originalTimestamp, 5000);
        console.log("Data updated:", dataUpdated);
        
        if (!dataUpdated) {
          console.log("No new data received within timeout, using cached data");
        } else {
          console.log("Received fresh data from turntable bot");
        }
      } else {
        console.log("Failed to send room info request");
      }
      
      // Log current song data for debugging
      console.log("Current song data:", currentSong);
      
      // Get the current DJ
      const currentDJ = currentSong.djName || "No DJ";
      const djsArray = getDJsArray();
      
      // Filter out empty queue - if queue says "Empty" or similar, treat as empty array
      const actualDjsArray = djsArray.filter(dj => dj && dj.trim() !== "" && dj !== "Queue is empty" && dj !== "Empty");
      
      // Format current track information
      const trackInfo = currentSong.songName && currentSong.artist 
        ? `${currentSong.artist} - ${currentSong.songName}`
        : "No track information available";
      
      console.log("Formatted track info:", trackInfo);
      console.log("Current DJ:", currentDJ);
      
      // Create an embed for better formatting
      const embed = new EmbedBuilder()
        .setColor(0x00FF00) // Green color for online
        .setTitle('🎧 Now Playing')
        .setDescription(trackInfo)
        .addFields({ name: 'Current DJ', value: currentDJ, inline: true });
      
      // Add DJs currently on decks if available
      if (currentSong.djsOnDecks && Array.isArray(currentSong.djsOnDecks)) {
        if (currentSong.djsOnDecks.length > 0) {
          const displayDjsOnDecks = currentSong.djsOnDecks.join(', ');
          embed.addFields({ 
            name: `DJs on Decks (${currentSong.djsOnDecks.length})`, 
            value: displayDjsOnDecks 
          });
        }
      }
      
      // Always show DJ Queue section, even if empty
      if (actualDjsArray.length > 0) {
        // Create a string with all DJs in queue (or just first few if many)
        const displayDJs = actualDjsArray.length <= 10 
          ? actualDjsArray.join('\n') 
          : actualDjsArray.slice(0, 10).join('\n') + `\n... and ${actualDjsArray.length - 10} more`;
        
        embed.addFields({ name: `DJ Queue (${actualDjsArray.length})`, value: displayDJs });
      } else {
        // Show empty queue
        embed.addFields({ name: `DJ Queue (0)`, value: 'Queue is empty' });
      }
      
      // Add audience information if available
      if (currentSong.audience && Array.isArray(currentSong.audience)) {
        if (currentSong.audience.length > 0) {
          // Create a string with all audience members (or just first few if many)
          const displayAudience = currentSong.audience.length <= 15
            ? currentSong.audience.join(', ')
            : currentSong.audience.slice(0, 15).join(', ') + ` ... and ${currentSong.audience.length - 15} more`;
          
          embed.addFields({ 
            name: `Audience (${currentSong.audience.length})`, 
            value: displayAudience 
          });
        } else {
          embed.addFields({ 
            name: 'Audience', 
            value: 'No one in audience' 
          });
        }
      }
      
      // Add turntable bot status at the bottom
      embed.addFields({ name: 'Turntable Bot', value: '🟢 Online', inline: true });
      
      message.reply({ embeds: [embed] });
      
    } catch (error) {
      console.error('Error in !playing command:', error);
      
      // Send error embed
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ Error')
        .setDescription('Sorry, there was an error getting the current playing information.')
        .addFields({ name: 'Error Details', value: 'Check the console for more information.' });
      
      message.reply({ embeds: [errorEmbed] });
    }
  }
  
  // Command to show the First Friday DJ schedule
  if (message.content === "!djtimes") {
    const nextFirstFriday = getNextFirstFriday();
    displayFirstFridaySchedule(message, nextFirstFriday);
  }
  
  // Command to show a specific first Friday by specifying year and month
  if (message.content.startsWith("!djtimes ")) {
    const args = message.content.split(' ');
    
    // Check if format is correct
    if (args.length === 3) {
      const year = parseInt(args[1], 10);
      const month = parseInt(args[2], 10);
      
      // Validate year and month
      if (!isNaN(year) && !isNaN(month) && month >= 1 && month <= 12) {
        const firstFriday = getFirstFridayOfMonth(year, month);
        displayFirstFridaySchedule(message, firstFriday);
      } else {
        message.reply('Please provide a valid year and month: `!djtimes YYYY MM`');
      }
    } else {
      message.reply('To see a specific month\'s First Friday schedule, use: `!djtimes YYYY MM`');
    }
  }
  
  // Command to sign up for a First Friday DJ slot
  if (message.content.startsWith("!signup")) {
    const args = message.content.split(' ');
    
    // Check for command format
    if (args.length < 3) {
      return message.reply('Please use the format: `!signup <slot_number> <your_timezone>`\nExample: `!signup 2 America/New_York`');
    }
    
    const slotNumber = parseInt(args[1], 10);
    const timezone = args.slice(2).join(' ');
    const djName = message.author.username;
    const targetDate = getNextFirstFriday(); // Always schedule for the next first Friday
    
    try {
      // Validate timezone (simplified check)
      if (timeOffsets[timezone] === undefined) {
        return message.reply(`Invalid timezone. Please use one of the following: ${Object.keys(timeOffsets).join(', ')}`);
      }
      
      // Check if slot number is valid
      if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > availableTimeSlots.length) {
        return message.reply(`Invalid slot number. Please choose a number between 1 and ${availableTimeSlots.length}.`);
      }
      
      // Get the hour from the slot number
      const hour = availableTimeSlots[slotNumber - 1];
      
      // Get current schedule for the first Friday
      const schedule = await getScheduleForFirstFriday(targetDate);
      
      // Check if the slot is already taken
      if (schedule.slots[hour]) {
        return message.reply(`Sorry, the ${formatTimeSlot(hour)} slot is already taken by ${schedule.slots[hour].dj}.`);
      }
      
      // Check constraints
      if (!canScheduleDJ(djName, timezone, targetDate, hour, schedule)) {
        return message.reply(`Sorry, you cannot be scheduled for this time slot due to scheduling constraints.`);
      }
      
      // Assign the slot
      schedule.slots[hour] = {
        dj: djName,
        timezone: timezone
      };
      
      // Save the updated schedule
      await saveFirstFridaySchedule(schedule);
      
      // Calculate DJ's local time for confirmation message
      const timezoneOffset = timeOffsets[timezone] || 0;
      let localHour = (hour + timezoneOffset) % 24;
      if (localHour < 0) localHour += 24;
      const localHour12 = localHour % 12 || 12;
      const ampm = localHour < 12 ? 'am' : 'pm';
      
      // Confirm signup
      message.reply(`You've been scheduled for the First Friday event on ${formatDate(targetDate)} at ${formatTimeSlot(hour)} UTC (${localHour12}${ampm} ${timezone}).`);
      
    } catch (error) {
      console.error('Error in signup process:', error);
      message.reply('Sorry, there was an error processing your signup request.');
    }
  }
  
  // Command to list upcoming events (changed from firstfridays)
  if (message.content === "!events") {
    const embed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('🎧 Upcoming Events')
      .setDescription('Here are the next 6 events:');
    
    // Generate the next 6 first Fridays
    const fridays = getUpcomingFirstFridays(6);
    
    // Add each date to the embed
    fridays.forEach((friday, index) => {
      embed.addFields({ name: `Event #${index + 1}`, value: formatDate(friday), inline: true });
    });
    
    // Add instructions
    embed.addFields({
      name: 'How to Sign Up',
      value: 'Use `!djtimes` to see the schedule for the next event\nUse `!signup <slot_number> <timezone>` to sign up'
    });
    
    message.reply({ embeds: [embed] });
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);