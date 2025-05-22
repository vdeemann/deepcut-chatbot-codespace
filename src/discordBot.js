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
  
  // If DJs is a string, split it by commas and trim whitespace
  if (typeof queueData.DJs === 'string') {
    return queueData.DJs.split(',').map(dj => dj.trim());
  }
  
  // Fallback to empty array
  return [];
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

// Helper function to display First Friday schedule
async function displayFirstFridaySchedule(message, date) {
  try {
    // Get schedule for the requested first Friday
    const schedule = await getScheduleForFirstFriday(date);
    
    // Create a formatted display of the schedule
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle(`🎧 First Friday DJ Schedule - ${formatDate(date)}`)
      .setFooter({ text: 'DJ Radio Scheduler' })
      .setTimestamp();
    
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
    console.error('Error displaying First Friday times:', error);
    message.reply('Sorry, there was an error retrieving the schedule.');
  }
}

// Subscribe to Redis channels
redisSub.subscribe("channel-1", "channel-2", (err, count) => {
  if (err) {
    console.error("Failed to subscribe:", err.message);
  } else {
    console.log(`Subscribed to ${count} channels successfully!`);
  }
});

// Handle incoming Redis messages
redisSub.on("message", (channel, message) => {
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
  
  // Respond to !song command
  if (message.content === "!song") {
    if (currentSong && currentSong.songName && currentSong.artist) {
      message.reply(`Now playing: ${currentSong.songName} by ${currentSong.artist}`);
    } else {
      message.reply("No song information available.");
    }
  }
  
  // Handle !playing command
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
  
  // Command to list upcoming First Fridays
  if (message.content === "!firstfridays") {
    const embed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('🎧 Upcoming First Friday Events')
      .setDescription('Here are the next 6 First Friday events:')
      .setFooter({ text: 'DJ Radio Scheduler' })
      .setTimestamp();
    
    // Generate the next 6 first Fridays
    const fridays = getUpcomingFirstFridays(6);
    
    // Add each date to the embed
    fridays.forEach((friday, index) => {
      embed.addFields({ name: `First Friday #${index + 1}`, value: formatDate(friday), inline: true });
    });
    
    // Add instructions
    embed.addFields({
      name: 'How to Sign Up',
      value: 'Use `!djtimes` to see the schedule for the next First Friday\nUse `!signup <slot_number> <timezone>` to sign up'
    });
    
    message.reply({ embeds: [embed] });
  }
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);