// Import required modules
const Bot = require("ttapi");
const Queue = require("./queue");
const { Mutex } = require("async-mutex");

// Optional Redis import - controlled by environment flag
let Redis = null;
let redisPublisher = null;
let redisSubscriber = null;
let redisEnabled = false;

// Check if Redis should be enabled via flag
const enableRedis = process.env.ENABLE_REDIS === 'true';

if (enableRedis) {
  if (!process.env.UPSTASH_REDIS_AUTH) {
    console.error("ENABLE_REDIS is true but UPSTASH_REDIS_AUTH is not provided!");
    process.exit(1);
  }
  
  try {
    Redis = require("ioredis");
    // Create separate Redis connections for publishing and subscribing
    redisPublisher = new Redis(process.env.UPSTASH_REDIS_AUTH);
    redisSubscriber = new Redis(process.env.UPSTASH_REDIS_AUTH);
    redisEnabled = true;
    console.log("Redis integration enabled");
  } catch (error) {
    console.error("Redis module not found or connection failed:", error.message);
    console.error("Install ioredis: npm install ioredis");
    process.exit(1);
  }
} else {
  console.log("Redis integration disabled (ENABLE_REDIS not set to 'true')");
  redisEnabled = false;
}

// Initialize bot and services
const bot = new Bot(
  process.env.DEEPCUT_BOT_AUTH,
  process.env.DEEPCUT_BOT_USERID,
  process.env.DEEPCUT_BOT_ROOMID,
);
const djQueue = new Queue();

// Track recently played DJs with timestamps
const recentlyPlayedDJs = new Map();

// NEW: Track DJs who should be removed after their song ends (Fair Turn System)
const djsToRemoveAfterSong = new Map(); // djName -> { userId, reason }

// Track users who left recently (for refresh detection)
const recentlyLeftUsers = new Map(); // username -> timestamp
const REFRESH_GRACE_PERIOD = 30000; // 30 seconds to rejoin before being removed from queue

// Queue state control
let queueEnabled = false;
let queueLocked = false;
let lastErrorTime = 0;
const ERROR_COOLDOWN = 5000; // 5 seconds
const mutex = new Mutex();

// Track DJ song counts and queue size enforcement
const QUEUE_SIZE_THRESHOLD = 6; // When queue reaches this size, enforce one song per DJ
const QUEUE_FULL_SIZE = 5; // When queue reaches this size, it's considered full
const djSongCounts = new Map(); // Track how many songs each DJ has played in their turn
let enforceOneSongPerDJ = false; // Dynamic flag based on queue size
const DJ_WAIT_TIME = 60000; // 1 minute wait time

// NEW: Track song timing to detect skips
const songStartTimes = new Map(); // djName -> { startTime, minDuration }
const MIN_SONG_DURATION = 30000; // 30 seconds - if song ends before this, it was likely skipped

// Admin usernames
const adminUsers = [
  process.env.ADMIN_USERNAME_1,
  process.env.ADMIN_USERNAME_2,
  process.env.ADMIN_USERNAME_3,
].filter(Boolean); // Filter out undefined values

// Helper function for bot.speak with Promise
function speakAsync(message) {
  return new Promise((resolve) => {
    bot.speak(message);
    setTimeout(resolve, 100);
  });
}

// Helper function to get current timestamp for PMs
function getTimestamp() {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  return `----------------------- ${hours}:${minutes}:${seconds}`;
}

// Helper function to check if a user is an admin
function isAdmin(username) {
  return adminUsers.includes(username);
}

// NEW: Function to detect if a song was skipped
function wasSongSkipped(djName) {
  if (!songStartTimes.has(djName)) {
    return false; // No timing data, assume not skipped
  }
  
  const songData = songStartTimes.get(djName);
  const songDuration = Date.now() - songData.startTime;
  
  console.log(`Song duration for ${djName}: ${songDuration}ms (min: ${songData.minDuration}ms)`);
  
  // If song played for less than the minimum duration, it was likely skipped
  return songDuration < songData.minDuration;
}

// NEW: Function to track when a song starts
function trackSongStart(djName, expectedDuration = null) {
  const startTime = Date.now();
  // Use either the expected duration or minimum duration, whichever is smaller
  const minDuration = expectedDuration ? Math.min(expectedDuration * 0.8, MIN_SONG_DURATION) : MIN_SONG_DURATION;
  
  songStartTimes.set(djName, {
    startTime: startTime,
    minDuration: minDuration
  });
  
  console.log(`Tracking song start for ${djName} at ${startTime}, min duration: ${minDuration}ms`);
}

// Optional Redis publishing functions
function publishToRedis(channel, data) {
  if (redisEnabled && redisPublisher) {
    return redisPublisher.publish(channel, JSON.stringify(data))
      .then(() => {
        console.log(`Published to ${channel}:`, JSON.stringify(data));
      })
      .catch(err => {
        console.error(`Redis publish error for ${channel}:`, err);
      });
  } else {
    console.log(`Would publish to ${channel} (Redis disabled):`, JSON.stringify(data));
    return Promise.resolve();
  }
}

// Function to handle room info requests and publish current data (optional)
function handleGetCurrentRoomInfoRequest() {
  console.log("Processing request for current room info");
  
  // Get current room information
  bot.roomInfo(false, function (data) {
    try {
      console.log("Retrieved room info for Discord bot request");
      
      if (!data || !data.room || !data.room.metadata) {
        console.log("No room data available");
        const fallbackSongInfo = {
          songName: "No room data",
          artist: "Unknown", 
          djName: "Unknown",
          startTime: Date.now(),
          roomName: "Unknown",
          audience: [],
          djsOnDecks: []
        };
        publishToRedis("channel-2", fallbackSongInfo);
        return;
      }
      
      // Get current song info if available
      let songInfo = {
        songName: "No song playing",
        artist: "Unknown", 
        djName: "No DJ",
        startTime: Date.now(),
        roomName: data.room.name || "Unknown",
        audience: [],
        djsOnDecks: []
      };
      
      // If there's a current song playing
      if (data.room.metadata.current_song && data.room.metadata.current_song.metadata) {
        const currentSong = data.room.metadata.current_song;
        songInfo = {
          songName: currentSong.metadata.song || "Unknown song",
          artist: currentSong.metadata.artist || "Unknown artist",
          djName: currentSong.djname || "Unknown DJ",
          startTime: currentSong.starttime || Date.now(),
          roomName: data.room.name || "Unknown",
          audience: [],
          djsOnDecks: []
        };
      }
      
      // Get DJs currently on decks and audience information
      const users = data.users || [];
      const currentDjIds = data.room.metadata.djs || [];
      const audience = [];
      const djsOnDecks = [];
      
      // First, get DJ names from their IDs
      for (const djId of currentDjIds) {
        for (const user of users) {
          if (user.userid === djId) {
            djsOnDecks.push(user.name);
            break;
          }
        }
      }
      
      // Then get audience (users who are not DJs)
      for (const user of users) {
        if (!currentDjIds.includes(user.userid)) {
          audience.push(user.name);
        }
      }
      
      songInfo.audience = audience;
      songInfo.djsOnDecks = djsOnDecks;
      
      // Publish updated song info to channel-2 (if Redis enabled)
      publishToRedis("channel-2", songInfo);
      
      // Also publish queue info to channel-1 (if Redis enabled)
      const queueMessage = { 
        DJs: djQueue.print(),
        locked: queueLocked
      };
      
      publishToRedis("channel-1", queueMessage);
        
    } catch (err) {
      console.error("Error processing room info request:", err);
      const errorSongInfo = {
        songName: "Error retrieving data",
        artist: "Unknown", 
        djName: "Unknown",
        startTime: Date.now(),
        roomName: "Unknown",
        audience: [],
        djsOnDecks: []
      };
      publishToRedis("channel-2", errorSongInfo);
    }
  });
}

// Function to check and update queue size enforcement
function updateQueueSizeEnforcement() {
  const previousState = enforceOneSongPerDJ;
  enforceOneSongPerDJ = djQueue.size() >= QUEUE_SIZE_THRESHOLD;
  
  // If state changed, announce it
  if (previousState !== enforceOneSongPerDJ && queueEnabled) {
    if (enforceOneSongPerDJ) {
      bot.speak(`Queue has reached ${QUEUE_SIZE_THRESHOLD}+ people. Each DJ will now be limited to ONE SONG PER TURN. After playing, DJs must wait 1 minute before rejoining the decks but will remain in the queue.`);
    } else {
      bot.speak(`Queue is now under ${QUEUE_SIZE_THRESHOLD} people. DJs may play multiple songs per turn.`);
    }
  }
  
  console.log(`Queue size enforcement updated: ${enforceOneSongPerDJ ? "ON" : "OFF"} (${djQueue.size()} DJs in queue)`);
}

// Function to check if queue is full and announce
function checkQueueFullStatus() {
  const queueSize = djQueue.size();
  if (queueSize === QUEUE_FULL_SIZE) {
    bot.speak(`DJ queue is now FULL (${QUEUE_FULL_SIZE} DJs). New users should type /a to join the queue and wait for an open spot.`);
  }
}

// Function to reset a DJ's song count
function resetDJSongCount(username) {
  djSongCounts.set(username, 0);
}

// Function to increment a DJ's song count
function incrementDJSongCount(username) {
  const currentCount = djSongCounts.get(username) || 0;
  djSongCounts.set(username, currentCount + 1);
  return currentCount + 1;
}

// Function to get a DJ's song count
function getDJSongCount(username) {
  return djSongCounts.get(username) || 0;
}

// Function to add a DJ to the recently played list with timestamp and set a timer to alert them
function addToRecentlyPlayed(username, userId) {
  const now = Date.now();
  recentlyPlayedDJs.set(username, now);
  console.log(`Added ${username} to recently played list with timestamp ${now} (must wait regardless of queue size changes)`);
  
  // Set a timeout to alert the DJ when their cooldown period is up
  setTimeout(() => {
    // Check if the DJ is still in cooldown (they might have been removed by admin)
    if (recentlyPlayedDJs.has(username)) {
      // Remove from recently played list
      recentlyPlayedDJs.delete(username);
      
      // Send private message to the DJ instead of public announcement
      bot.pm(
        "══════════════════\n" +
        "Your 1-minute wait time is up!\n" +
        "You can now rejoin the decks.\n" +
        ".\n.\n.\n.\n.\n" +
        "Use /q to view queue, /a to join if removed, or /usercommands for more.\n" +
        getTimestamp(),
        userId
      );
      
      console.log(`${username}'s cooldown period has ended, sent PM notification`);
    }
  }, DJ_WAIT_TIME);
}

// Function to check if a DJ can play again (1 minute passed)
function canDJPlayAgain(username) {
  if (!recentlyPlayedDJs.has(username)) {
    return true; // Not in the recently played list
  }
  
  const timestamp = recentlyPlayedDJs.get(username);
  const currentTime = Date.now();
  const elapsedTime = currentTime - timestamp;
  
  // Check if enough time has passed (1 minute)
  if (elapsedTime >= DJ_WAIT_TIME) {
    // Remove from recently played list
    recentlyPlayedDJs.delete(username);
    return true;
  }
  
  // Return how many seconds left to wait
  return Math.ceil((DJ_WAIT_TIME - elapsedTime) / 1000);
}

// Queue publication functions (optional Redis)
function publishQueueToRedis() {
  const message = { 
    DJs: djQueue.print(),
    locked: queueLocked
  };
  
  return publishToRedis("channel-1", message);
}

function updateQueuePublication() {
  // Only publish when there are actual queue changes
  publishQueueToRedis();
}

function startQueuePublication() {
  return mutex.acquire().then((release) => {
    try {
      // Only publish when queue is enabled initially
      if (queueEnabled) {
        console.log(`Queue publication ready (${redisEnabled ? 'Redis enabled' : 'standalone mode'})`);
        publishQueueToRedis();
      }
      return Promise.resolve();
    } finally {
      release();
    }
  }).catch(err => {
    console.error("Error in startQueuePublication:", err);
    return Promise.reject(err);
  });
}

function stopQueuePublication() {
  return mutex.acquire().then((release) => {
    try {
      console.log("Queue publication stopped");
      return Promise.resolve();
    } finally {
      release();
    }
  }).catch(err => {
    console.error("Error in stopQueuePublication:", err);
    return Promise.reject(err);
  });
}

// Optional Redis subscriber setup
if (redisEnabled && redisSubscriber) {
  // Subscribe to bot-commands channel to handle requests from Discord bot
  redisSubscriber.subscribe("bot-commands", (err, count) => {
    if (err) {
      console.error("Failed to subscribe to bot-commands:", err.message);
    } else {
      console.log(`Subscribed to bot-commands channel successfully!`);
    }
  });

  // Handle bot command messages
  redisSubscriber.on("message", (channel, message) => {
    if (channel === "bot-commands") {
      try {
        const commandData = JSON.parse(message);
        console.log("Received bot command:", commandData);
        
        if (commandData.command === "getCurrentRoomInfo") {
          handleGetCurrentRoomInfoRequest();
        } else if (commandData.command === "ping") {
          // Respond to ping with pong to indicate bot is online
          console.log("Received ping, sending pong response");
          publishToRedis("bot-commands", {
            command: "pong",
            timestamp: Date.now(),
            botStatus: "online"
          });
        }
      } catch (e) {
        console.error("Error parsing bot command:", e);
      }
    }
  });
} else {
  console.log("Redis subscriber not available - Discord bot integration disabled");
}

// Clear all existing event listeners to start fresh
bot.removeAllListeners();

// Handle getting current DJs and adding them to the queue
function handleSyncQueue(username) {
  console.log(`Admin ${username} executed /syncqueue command`);
  
  // Only allow admins to perform this action
  if (!isAdmin(username)) {
    bot.speak(`@${username} you don't have permission to get current DJs and add them to the queue.`);
    return Promise.resolve(); // Return immediately
  }
  
  // Return a Promise that resolves when the sync is actually complete
  return new Promise((resolve) => {
    // First clear the queue to ensure we're starting fresh
    djQueue.clear();
    console.log("Queue cleared before updating with current DJs");
    
    // Use roomInfo to get current DJs in the booth
    bot.roomInfo(false, function (data) {
      try {
        console.log("Retrieved room info for /syncqueue");
        
        // Check if data and required properties exist
        if (!data || !data.room || !data.room.metadata || !data.room.metadata.djs) {
          bot.speak(`Error retrieving room data. Please try again.`);
          resolve(); // Resolve even on error
          return;
        }
        
        // Access the DJs array directly from room metadata
        const currentDjIds = data.room.metadata.djs || [];
        const users = data.users || [];
        const currentSong = data.room.metadata.current_song;
        let addedCount = 0;
        
        console.log(`Found ${currentDjIds.length} DJ IDs in the booth metadata`);
        
        // If there are no DJs in the booth, just report empty queue
        if (currentDjIds.length === 0) {
          publishQueueToRedis(); // Publish empty queue
          bot.speak(`No DJs currently on decks. Queue is empty.`);
          console.log("No DJs in booth, queue remains empty");
          resolve(); // Resolve after speaking
          return;
        }
        
        // Find DJ names from user IDs
        const djsOnDecks = [];
        for (let i = 0; i < currentDjIds.length; i++) {
          const djId = currentDjIds[i];
          const user = users.find(u => u.userid === djId);
          if (user) {
            djsOnDecks.push(user.name);
          }
        }
        
        console.log(`DJs on decks (left to right): ${djsOnDecks.join(', ')}`);
        
        // Determine the main DJ and proper queue order
        let queueOrder = [];
        
        if (currentSong && currentSong.djid && currentSong.djname) {
          const mainDJ = currentSong.djname;
          const mainDJIndex = currentDjIds.indexOf(currentSong.djid);
          
          console.log(`Main DJ: ${mainDJ} (position ${mainDJIndex})`);
          
          if (mainDJIndex !== -1 && djsOnDecks.includes(mainDJ)) {
            // Start with the main DJ
            queueOrder.push(mainDJ);
            
            // Add remaining DJs in rotation order (left to right from main DJ)
            for (let i = 1; i < currentDjIds.length; i++) {
              const nextIndex = (mainDJIndex + i) % currentDjIds.length;
              const nextDJId = currentDjIds[nextIndex];
              const nextUser = users.find(u => u.userid === nextDJId);
              
              if (nextUser && !queueOrder.includes(nextUser.name)) {
                queueOrder.push(nextUser.name);
              }
            }
            
            console.log(`Queue order (main DJ first, then rotation): ${queueOrder.join(', ')}`);
          } else {
            // Fallback: main DJ not found or not on decks, use deck order
            queueOrder = djsOnDecks;
            console.log(`Fallback: using deck order: ${queueOrder.join(', ')}`);
          }
        } else {
          // No current song, use deck order
          queueOrder = djsOnDecks;
          console.log(`No current song, using deck order: ${queueOrder.join(', ')}`);
        }
        
        // Add DJs to queue in the determined order
        queueOrder.forEach(djName => {
          djQueue.enqueue(djName);
          resetDJSongCount(djName);
          addedCount++;
          console.log(`Added DJ to queue: ${djName}`);
        });
        
        // Always publish the queue since we cleared it
        publishQueueToRedis();
        
        // Check if we need to enforce one song per DJ
        updateQueueSizeEnforcement();
        
        // Build response message
        let message = `Queue sync completed. `;
        
        if (addedCount > 0) {
          message += `Added ${addedCount} DJs to the queue in rotation order. `;
        } else {
          message += `No DJs found to add to the queue. `;
        }
        
        message += `Current queue: ${djQueue.print() || "Empty"}`;
        
        // Speak the message and then resolve the Promise
        bot.speak(message);
        console.log("syncqueue command completed successfully");
        
        // Add a small delay to ensure the message is sent before resolving
        setTimeout(() => {
          resolve();
        }, 100);
        
      } catch (innerErr) {
        console.error("Error processing room info:", innerErr);
        bot.speak(`Error checking current DJs. Please try again.`);
        resolve(); // Resolve even on error
      }
    });
  });
}

// Handle admin command functions
function handleAdminCommand(command, username, targetUsername = null) {
  return mutex.acquire().then((release) => {
    let speakPromise;
    
    try {
      switch (command) {
        case "enablequeue":
          if (isAdmin(username)) {
            // Only enable if not already enabled
            if (!queueEnabled) {
              queueEnabled = true;
              // Clear recently played map when enabling queue
              recentlyPlayedDJs.clear();
              
              speakPromise = speakAsync("Live DJ queue system is now ENABLED. Current DJs will be automatically added to the queue.")
                .then(() => {
                  // Automatically sync current DJs when enabling
                  return handleSyncQueue(username);
                })
                .then(() => {
                  // Check queue size and announce if one-song rule is in effect
                  updateQueueSizeEnforcement();
                  
                  // Announce user commands after DJ booth sync completes
                  return speakAsync(
                    "DJ Queue Commands:\n" +
                    "• /q - View the current DJ queue\n" +
                    "• /a - Add yourself to the DJ queue\n" +
                    "• /r - Remove yourself from the DJ queue\n" +
                    "Type /usercommands for more help!"
                  );
                })
                .then(() => {
                  release(); // Release mutex before starting publication
                  return startQueuePublication();
                });
              return speakPromise;
            } else {
              speakPromise = speakAsync("Live DJ queue system is already enabled.");
            }
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to enable the live DJ queue.`);
          }
          break;
          
        case "disablequeue":
          if (isAdmin(username)) {
            // Only disable if not already disabled
            if (queueEnabled) {
              queueEnabled = false;
              // Reset enforcement state and clear recently played map
              enforceOneSongPerDJ = false;
              recentlyPlayedDJs.clear();
              
              speakPromise = speakAsync("Live DJ queue system is now DISABLED.")
                .then(() => {
                  // Publish disabled status to Redis before stopping publication (if Redis enabled)
                  const disabledMessage = { 
                    DJs: "disabled",
                    locked: false
                  };
                  return publishToRedis("channel-1", disabledMessage)
                    .then(() => {
                      release(); // Release mutex before stopping publication
                      return stopQueuePublication();
                    });
                });
              return speakPromise;
            } else {
              speakPromise = speakAsync("Live DJ queue system is already disabled.");
            }
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to disable the live DJ queue.`);
          }
          break;
          
        case "lockqueue":
          if (isAdmin(username)) {
            queueLocked = !queueLocked;
            speakPromise = speakAsync(queueLocked 
              ? "Live DJ queue is now LOCKED. Only admins can modify the queue." 
              : "Live DJ queue is now UNLOCKED. Users can modify the queue.");
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to lock/unlock the live DJ queue.`);
          }
          break;
          
        case "remove":
          if (isAdmin(username) && targetUsername) {
            if (djQueue.contains(targetUsername)) {
              djQueue.remove(targetUsername);
              // Remove user from song counts tracking and recently played
              djSongCounts.delete(targetUsername);
              recentlyPlayedDJs.delete(targetUsername);
              
              // Check if user is currently DJing and mark for removal after song (Fair Turn System)
              bot.roomInfo(false, function(roomData) {
                try {
                  const currentDjIds = roomData.room.metadata.djs || [];
                  const users = roomData.users || [];
                  
                  // Find if this user is currently on decks
                  const userOnDecks = users.find(user => 
                    user.name === targetUsername && currentDjIds.includes(user.userid)
                  );
                  
                  if (userOnDecks) {
                    // Mark this DJ to be removed after their current song ends
                    djsToRemoveAfterSong.set(targetUsername, {
                      userId: userOnDecks.userid,
                      reason: 'admin_removal'
                    });
                    console.log(`Marked ${targetUsername} for admin removal after song`);
                  }
                } catch (error) {
                  console.error("Error checking DJ status for admin removal:", error);
                }
              });
              
              speakPromise = speakAsync(`@${targetUsername} has been removed from the queue by admin @${username}`)
                .then(() => {
                  updateQueuePublication();
                  
                  // Update queue size enforcement status
                  updateQueueSizeEnforcement();
                });
            } else {
              speakPromise = speakAsync(`@${username}: User "${targetUsername}" is not in the live DJ queue.`);
            }
          } else if (!targetUsername) {
            speakPromise = speakAsync(`@${username}: Please specify a username to remove. Format: /@r username`);
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to remove users from the queue.`);
          }
          break;
          
        case "add":
          if (isAdmin(username) && targetUsername) {
            if (!djQueue.contains(targetUsername)) {
              djQueue.enqueue(targetUsername);
              // Initialize song count for new DJ and remove from recently played
              resetDJSongCount(targetUsername);
              recentlyPlayedDJs.delete(targetUsername); // Admins can override wait time
              
              speakPromise = speakAsync(`@${targetUsername} has been added to the live DJ queue by admin @${username}`)
                .then(() => {
                  updateQueuePublication();
                  
                  // Check if we now need to enforce one song per DJ
                  updateQueueSizeEnforcement();
                  
                  // Check if queue is now full
                  checkQueueFullStatus();
                });
            } else {
              speakPromise = speakAsync(`@${username}: User "${targetUsername}" is already in the live DJ queue.`);
            }
          } else if (!targetUsername) {
            speakPromise = speakAsync(`@${username}: Please specify a username to add. Format: /@a username`);
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to add users to the queue.`);
          }
          break;
          
        case "clearqueue":
          if (isAdmin(username)) {
            // Only clear if queue is not empty
            if (!djQueue.isEmpty()) {
              djQueue.clear();
              // Clear all song count tracking and recently played list
              djSongCounts.clear();
              recentlyPlayedDJs.clear();
              
              speakPromise = speakAsync(`@${username} has cleared the live DJ queue.`)
                .then(() => {
                  updateQueuePublication();
                  
                  // Update queue size enforcement
                  updateQueueSizeEnforcement();
                });
            } else {
              speakPromise = speakAsync("The live DJ queue is already empty.");
            }
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to clear the live DJ queue.`);
          }
          break;
          
        // Reset wait timers for all DJs
        case "resetturns":
          if (isAdmin(username)) {
            recentlyPlayedDJs.clear();
            speakPromise = speakAsync(`@${username} has reset the wait time for all DJs. All DJs can now join the queue.`);
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to reset turn restrictions.`);
          }
          break;
          
        default:
          speakPromise = Promise.resolve();
      }
      
      return speakPromise.finally(() => {
        release();
      });
    } catch (err) {
      console.error(`Error in handleAdminCommand for ${command}:`, err);
      release();
      return Promise.reject(err);
    }
  });
}

function handleQueueCommand(command, username) {
  console.log(`Processing queue command: ${command} from ${username}`);
  return mutex.acquire().then((release) => {
    try {
      // Check if queue is disabled for regular queue commands
      if (!queueEnabled) {
        const currentTime = Date.now();
        if (currentTime - lastErrorTime > ERROR_COOLDOWN) {
          lastErrorTime = currentTime;
          return speakAsync("/q /a /r is only available when the live DJ queue is enabled by Admins")
            .finally(() => release());
        }
        release();
        return Promise.resolve();
      }

      let speakPromise;
      
      switch (command) {
        case "q":
          // Show queue logic - anyone can view the queue
          console.log(`Showing queue to ${username}: ${djQueue.print()}`);
          speakPromise = speakAsync(djQueue.print());
          break;

        case "a":
          // Add to queue logic - check if queue is locked and user is not admin
          if (queueLocked && !isAdmin(username)) {
            speakPromise = speakAsync(`@${username} The queue is currently locked. Only admins can modify it.`);
          } 
          else if (!djQueue.contains(username)) {
            djQueue.enqueue(username);
            // Initialize song count for this DJ
            resetDJSongCount(username);
            
            // Choose message based on current queue size (6+ = strict mode)
            const queueMessage = djQueue.size() >= QUEUE_SIZE_THRESHOLD ? 
              `Next in line is: @${username}` : 
              `Hop up! @${username}`;
            
            speakPromise = speakAsync(queueMessage)
              .then(() => {
                // Publish queue update only when there's an actual change
                publishQueueToRedis();
                
                // Check if we need to enforce one song per DJ
                updateQueueSizeEnforcement();
                
                // Check if queue is now full
                checkQueueFullStatus();
              });
          } else {
            speakPromise = speakAsync(`You are already in the live DJ queue. @${username}`);
          }
          break;

        case "r":
          // Remove from queue logic - check if queue is locked and user is not admin
          if (queueLocked && !isAdmin(username)) {
            speakPromise = speakAsync(`@${username} The queue is currently locked. Only admins can modify it.`);
          } else if (djQueue.contains(username)) {
            djQueue.remove(username);
            // Remove user from song counts tracking but keep recently played cooldown
            djSongCounts.delete(username);
            
            // Check if user is currently DJing and apply cooldown if queue was 6+ when they started
            bot.roomInfo(false, function(roomData) {
              try {
                const currentDjIds = roomData.room.metadata.djs || [];
                const users = roomData.users || [];
                const currentSong = roomData.room.metadata.current_song;
                
                // Find if this user is currently on decks
                const userOnDecks = users.find(user => 
                  user.name === username && currentDjIds.includes(user.userid)
                );
                
                if (userOnDecks) {
                  // Check if they're the one currently playing
                  const isCurrentlyPlaying = currentSong && currentSong.djname === username;
                  
                  if (isCurrentlyPlaying && enforceOneSongPerDJ) {
                    // User is trying to exploit by leaving queue while playing when 6+ people
                    // Apply immediate cooldown to prevent cutting in line
                    addToRecentlyPlayed(username, userOnDecks.userid);
                    console.log(`Applied immediate cooldown to ${username} for leaving queue while playing (6+ people) - prevents cutting exploitation`);
                    
                    // Mark for removal and inform about cooldown
                    djsToRemoveAfterSong.set(username, {
                      userId: userOnDecks.userid,
                      reason: 'self_removal_with_cooldown'
                    });
                    
                    bot.speak(`${username} will be removed from the queue and must wait 1 minute before rejoining (prevents cutting in line).`);
                  } else if (djQueue.size() > 0) {
                    // Normal removal without cooldown exploitation
                    djsToRemoveAfterSong.set(username, {
                      userId: userOnDecks.userid,
                      reason: 'self_removal'
                    });
                    
                    bot.speak(`${username} will be removed from the live DJ queue after their song has played.`);
                  }
                  
                  console.log(`Marked ${username} for removal after song (exploitation prevention active)`);
                } else {
                  // User not currently on decks, just remove from queue
                  bot.speak(`${username} removed from the live DJ queue.`);
                }
              } catch (error) {
                console.error("Error checking DJ status for removal:", error);
                bot.speak(`${username} removed from the live DJ queue.`);
              }
            });
            
            // Note: We don't remove from recentlyPlayedDJs to prevent cooldown exploitation
            console.log(`${username} removed from queue but cooldown preserved (if any) to prevent exploitation`);
            
            speakPromise = Promise.resolve().then(() => {
              // Publish queue update only when there's an actual change
              publishQueueToRedis();
              
              // Update queue size enforcement
              updateQueueSizeEnforcement();
            });
          } else {
            speakPromise = speakAsync(`You are not in the live DJ queue. @${username}`);
          }
          break;
          
        default:
          speakPromise = Promise.resolve();
      }
      
      return speakPromise.finally(() => {
        console.log(`Releasing mutex after handling queue command ${command}`);
        release();
      });
    } catch (err) {
      console.error(`Error in handleQueueCommand for ${command}:`, err);
      release();
      return Promise.reject(err);
    }
  });
}

// Handle queue status command
function handleQueueStatusCommand(username) {
  return mutex.acquire().then((release) => {
    try {
      // Generate status message
      let statusMessage = "DJ Queue System Status:\n";
      statusMessage += `• Queue System: ${queueEnabled ? "ENABLED" : "DISABLED"}\n`;
      statusMessage += `• Queue Lock: ${queueLocked ? "LOCKED (admin only)" : "UNLOCKED"}\n`;
      statusMessage += `• Live Updates: ${queueEnabled ? "EVENT-DRIVEN" : "INACTIVE"}\n`;
      statusMessage += `• Redis Integration: ${redisEnabled ? "ENABLED" : "DISABLED"}\n`;
      statusMessage += `• One Song Per DJ: ${enforceOneSongPerDJ ? "ENABLED (6+ in queue)" : "DISABLED"}\n`;
      statusMessage += `• Current Queue: ${djQueue.isEmpty() ? "Empty" : djQueue.print()}`;
      
      // Add recently played DJs with wait times
      if (recentlyPlayedDJs.size > 0) {
        statusMessage += `• DJs waiting to play again:\n`;
        
        // Convert the Map to an array and format each entry
        const waitingDJs = Array.from(recentlyPlayedDJs.entries()).map(([djName, timestamp]) => {
          const currentTime = Date.now();
          const elapsedTime = currentTime - timestamp;
          const remainingTime = Math.max(0, DJ_WAIT_TIME - elapsedTime);
          const remainingSeconds = Math.ceil(remainingTime / 1000);
          
          return `  - ${djName}: ${remainingSeconds} seconds remaining`;
        });
        
        statusMessage += waitingDJs.join('\n');
        statusMessage += '\n';
      }
      
      return speakAsync(statusMessage);
    } catch (err) {
      console.error("Error in handleQueueStatusCommand:", err);
      return Promise.reject(err);
    } finally {
      console.log("Releasing mutex after handling status command");
      release();
    }
  });
}

// Function to display all admin commands
function handleAdminCommandsDisplay(username) {
  console.log(`User ${username} requested admin commands list`);
  
  return mutex.acquire().then((release) => {
    try {
      const commandsList1 = `Admin Commands for DJ Queue System:
• /enablequeue - Enable the DJ queue system
• /disablequeue - Disable the DJ queue system
• /lockqueue - Toggle queue lock status (locked/unlocked)
• /clearqueue - Clear all entries from the queue
• /syncqueue - Add current DJs to the queue`;

      const commandsList2 = `• /resetturns - Reset all DJ wait times 
• /shutdown - Shutdown the bot
• /@a [username] - Add specific user to the queue
• /@r [username] - Remove specific user from the queue
• /queuestatus - Show complete system status`;
      
      return speakAsync(commandsList1)
        .then(() => {
          // Small delay between messages
          return new Promise(resolve => setTimeout(resolve, 500));
        })
        .then(() => {
          return speakAsync(commandsList2);
        });
    } catch (err) {
      console.error("Error in handleAdminCommandsDisplay:", err);
      return Promise.reject(err);
    } finally {
      release();
    }
  });
}

// Function to display all user commands
function handleUserCommandsDisplay(username) {
  console.log(`User ${username} requested user commands list`);
  
  return mutex.acquire().then((release) => {
    try {
      const commandsList = `User Commands for DJ Queue System:
• /q - View the current DJ queue
• /a - Add yourself to the DJ queue
• /r - Remove yourself from the DJ queue
• /queuestatus - Show complete system status
• /usercommands - Display this help message`;
      
      return speakAsync(commandsList);
    } catch (err) {
      console.error("Error in handleUserCommandsDisplay:", err);
      return Promise.reject(err);
    } finally {
      release();
    }
  });
}

// Handle chat commands
bot.on("speak", function (data) {
  const text = data.text.trim();
  const username = data.name;

  console.log(`Received command: "${text}" from ${username}`);

  // Handle admin commands
  if (text === "/enablequeue" || text.endsWith(" /enablequeue")) {
    console.log("Processing enablequeue command");
    handleAdminCommand("enablequeue", username)
      .catch(err => {
        console.error("Error handling enablequeue:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  if (text === "/disablequeue" || text.endsWith(" /disablequeue")) {
    console.log("Processing disablequeue command");
    handleAdminCommand("disablequeue", username)
      .catch(err => {
        console.error("Error handling disablequeue:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  if (text === "/lockqueue" || text.endsWith(" /lockqueue")) {
    console.log("Processing lockqueue command");
    handleAdminCommand("lockqueue", username)
      .catch(err => {
        console.error("Error handling lockqueue:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  if (text === "/clearqueue" || text.endsWith(" /clearqueue")) {
    console.log("Processing clearqueue command");
    handleAdminCommand("clearqueue", username)
      .catch(err => {
        console.error("Error handling clearqueue:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  if (text === "/resetturns" || text.endsWith(" /resetturns")) {
    console.log("Processing resetturns command");
    handleAdminCommand("resetturns", username)
      .catch(err => {
        console.error("Error handling resetturns:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  // Add handler for the shutdown command
  if (text === "/shutdown" || text.endsWith(" /shutdown")) {
    console.log("Processing shutdown command");
    if (isAdmin(username)) {
      bot.speak("🤖 going offline. Queue system temporarily unavailable.");
      setTimeout(() => {
        console.log("Admin-initiated shutdown complete");
        process.exit(0);
      }, 2000);
    } else {
      bot.speak(`@${username} you don't have permission to shutdown the bot.`);
    }
    return;
  }
  
  // Add handler for the syncqueue command
  if (text === "/syncqueue" || text.endsWith(" /syncqueue")) {
    console.log("Processing syncqueue command");
    handleSyncQueue(username)
      .catch(err => {
        console.error("Error in syncqueue command:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  // Handle queue status command - available to all users
  if (text === "/queuestatus" || text.endsWith(" /queuestatus")) {
    console.log("Processing queuestatus command");
    handleQueueStatusCommand(username)
      .catch(err => {
        console.error("Error handling queue status command:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  // Command to show all admin commands - only visible to admins
  if (text === "/admincommands" || text.endsWith(" /admincommands")) {
    console.log("Processing admin commands display request");
    if (isAdmin(username)) {
      handleAdminCommandsDisplay(username)
        .catch(err => {
          console.error("Error displaying admin commands:", err);
          bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
        });
    } else {
      bot.speak(`@${username}: You don't have permission to view admin commands.`);
    }
    return;
  }

  // Command to show all user commands - visible to everyone
  if (text === "/usercommands" || text.endsWith(" /usercommands")) {
    console.log("Processing user commands display request");
    handleUserCommandsDisplay(username)
      .catch(err => {
        console.error("Error displaying user commands:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  // Handle admin command to remove a specific user from queue
  if (text.includes("/@r") && isAdmin(username)) {
    console.log("Processing admin remove command");
    const parts = text.split("/@r");
    if (parts.length > 1) {
      const targetUsername = parts[1].trim();
      handleAdminCommand("remove", username, targetUsername)
        .catch(err => {
          console.error("Error handling admin remove:", err);
          bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
        });
    }
    return;
  }
  
  // Handle admin command to add a specific user to queue
  if (text.includes("/@a") && isAdmin(username)) {
    console.log("Processing admin add command");
    const parts = text.split("/@a");
    if (parts.length > 1) {
      const targetUsername = parts[1].trim();
      handleAdminCommand("add", username, targetUsername)
        .catch(err => {
          console.error("Error handling admin add:", err);
          bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
        });
    }
    return;
  }
  
  // Regular user commands
  if (text === "/q" || text.endsWith(" /q")) {
    console.log("Processing queue view command");
    handleQueueCommand("q", username)
      .catch(err => {
        console.error("Error handling queue command /q:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  if (text === "/a" || text.endsWith(" /a")) {
    console.log("Processing queue add command");
    handleQueueCommand("a", username)
      .catch(err => {
        console.error("Error handling queue command /a:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  if (text === "/r" || text.endsWith(" /r")) {
    console.log("Processing queue remove command");
    handleQueueCommand("r", username)
      .catch(err => {
        console.error("Error handling queue command /r:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  // If we get here, it wasn't a recognized command
  console.log(`Not a recognized command: "${text}"`);
});

// UPDATED: Handle new song events with complete audience and DJ data + skip detection
bot.on("newsong", function (data) {
  try {
    // Check if song data exists
    if (!data.room?.metadata?.current_song?.metadata) {
      console.log("No song metadata available");
      return;
    }
    
    const currentDJ = data.room.metadata.current_song.djname;
    
    // NEW: Track when this song started for skip detection
    if (currentDJ) {
      trackSongStart(currentDJ);
    }
    
    // Get current room information to populate audience and DJs
    bot.roomInfo(false, function (roomData) {
      try {
        // Extract relevant song information
        const songInfo = {
          songName: data.room.metadata.current_song.metadata.song,
          artist: data.room.metadata.current_song.metadata.artist,
          djName: data.room.metadata.current_song.djname,
          startTime: Date.now(),
          roomName: data.room.name,
          audience: [],
          djsOnDecks: []
        };
        
        // Populate audience and DJs data if roomData is available
        if (roomData && roomData.users && roomData.room?.metadata?.djs) {
          const users = roomData.users || [];
          const currentDjIds = roomData.room.metadata.djs || [];
          const audience = [];
          const djsOnDecks = [];
          
          // First, get DJ names from their IDs
          for (const djId of currentDjIds) {
            for (const user of users) {
              if (user.userid === djId) {
                djsOnDecks.push(user.name);
                break;
              }
            }
          }
          
          // Then get audience (users who are not DJs)
          for (const user of users) {
            if (!currentDjIds.includes(user.userid)) {
              audience.push(user.name);
            }
          }
          
          songInfo.audience = audience;
          songInfo.djsOnDecks = djsOnDecks;
          
          console.log(`Newsong: Found ${audience.length} audience members and ${djsOnDecks.length} DJs on decks`);
        }
        
        // Publish to Redis channel-2 (if Redis enabled)
        publishToRedis("channel-2", songInfo);
      } catch (innerError) {
        console.error("Error getting room info in newsong handler:", innerError);
        
        // Fallback: publish song info without audience data
        const fallbackSongInfo = {
          songName: data.room.metadata.current_song.metadata.song,
          artist: data.room.metadata.current_song.metadata.artist,
          djName: data.room.metadata.current_song.djname,
          startTime: Date.now(),
          roomName: data.room.name,
          audience: [],
          djsOnDecks: []
        };
        
        publishToRedis("channel-2", fallbackSongInfo);
      }
    });
  } catch (error) {
    console.error("Error in newsong handler:", error);
  }
});

// Handle user registered event to inform new users about the queue system
bot.on("registered", function (data) {
  try {
    const user = data.user[0];
    
    // Check if this is the bot itself joining
    if (user.userid === process.env.DEEPCUT_BOT_USERID) {
      const statusMessage = redisEnabled ? 
        "🤖 I'm online! DJ queue system ready. Redis integration enabled." :
        "🤖 I'm online! DJ queue system ready. Running in standalone mode.";
      bot.speak(statusMessage);
      return;
    }
    
    // Check if this user recently left (possible refresh)
    let isRefresh = false;
    if (recentlyLeftUsers.has(user.name)) {
      const leftTime = recentlyLeftUsers.get(user.name);
      const currentTime = Date.now();
      
      // If they rejoined within grace period, they were likely refreshing
      if (currentTime - leftTime <= REFRESH_GRACE_PERIOD) {
        console.log(`${user.name} rejoined within grace period (${currentTime - leftTime}ms) - likely a refresh`);
        recentlyLeftUsers.delete(user.name); // Clean up
        isRefresh = true;
      } else {
        // They took too long, remove them from recently left
        recentlyLeftUsers.delete(user.name);
      }
    }
    
    // Send a welcome message to the room for all users (including refreshers)
    setTimeout(() => {
      if (isRefresh) {
        bot.speak(`Welcome back, @${user.name}! 🎵`);
      } else {
        bot.speak(`Welcome to the room, @${user.name}! 🎵`);
      }
      
      // Send PM regardless of queue status
      // For refreshing users already in the queue, send a simpler message
      if (isRefresh && queueEnabled && djQueue.contains(user.name)) {
        bot.pm("══════════════════\n" +
               "Welcome back!\n" +
               ".\n.\n.\n.\n.\n.\n.\n.\n.\n.\n" +
               "You remain in the DJ queue.\n" + 
               getTimestamp(), user.userid);
        return; // Don't send the longer welcome message
      }
      
      // Send welcome PM to all users (queue enabled or disabled)
      let message = "══════════════════\n";
      message += isRefresh ? 
        "Welcome back! " :
        "Welcome! ";
      
      if (queueEnabled) {
        message += isRefresh ? 
          "As a reminder, this room uses a DJ queue system.\n" :
          "This room uses a DJ queue system.\n";
        
        message += ".\n.\n";
        
        if (djQueue.size() >= QUEUE_FULL_SIZE) {
          message += "The queue is currently full. Type /a to join the queue and wait for an open spot.\n";
        } else {
          message += "Type /a to join the DJ queue or click \"Play Music\" to hop on the decks.\n";
        }
        
        message += ".\n";
        
        if (enforceOneSongPerDJ) {
          message += "Queue has 6+ people so DJs are limited to one song per turn with a 1-minute wait between turns.\n";
        }
        
        if (isAdmin(user.name)) {
          message += "Use /q to see the current queue, /usercommands for user commands, and /admincommands for admin commands.\n" + getTimestamp();
        } else {
          message += "Use /q to see the current queue and /usercommands for all available commands.\n" + getTimestamp();
        }
      } else {
        // Queue is disabled - simple welcome message
        message += "Thanks for joining us!\n";
        message += ".\n.\n.\n";
        message += "Click \"Play Music\" to hop on the decks and start DJing.\n";
        message += ".\n.\n";
        
        if (isAdmin(user.name)) {
          message += "Use /usercommands for user and /admincommands for admin commands.\n" + getTimestamp();
        } else {
          message += "Use /usercommands to see available commands.\n" + getTimestamp();
        }
      }
      
      bot.pm(message, user.userid);
    }, 2000); // Delay to ensure user is fully loaded
  } catch (error) {
    console.error("Error in registered handler:", error);
  }
});

// Handle user leaving the room
bot.on("deregistered", function (data) {
  try {
    const user = data.user[0];
    
    // Don't announce when the bot itself leaves
    if (user.userid === process.env.DEEPCUT_BOT_USERID) {
      return;
    }
    
    // Clean up removal tracking if user leaves (Fair Turn System)
    if (djsToRemoveAfterSong.has(user.name)) {
      djsToRemoveAfterSong.delete(user.name);
      console.log(`Cleaned up removal tracking for ${user.name} (left room)`);
    }
    
    // Clean up song timing tracking if user leaves
    if (songStartTimes.has(user.name)) {
      songStartTimes.delete(user.name);
      console.log(`Cleaned up song timing for ${user.name} (left room)`);
    }
    
    // Announce that the user has left the room
    bot.speak(`@${user.name} has left the room.`);
    
    // Only manage queue if it's enabled
    if (!queueEnabled) return;
    
    // Record when they left for refresh detection
    recentlyLeftUsers.set(user.name, Date.now());
    console.log(`${user.name} left the room, added to recently left list`);
    
    // Set a timer to remove them from queue after grace period
    setTimeout(() => {
      mutex.acquire().then((release) => {
        try {
          // Check if they're still in the recently left list (they didn't rejoin)
          if (recentlyLeftUsers.has(user.name)) {
            const leftTime = recentlyLeftUsers.get(user.name);
            const currentTime = Date.now();
            
            // If enough time has passed and they haven't rejoined, remove from queue
            if (currentTime - leftTime >= REFRESH_GRACE_PERIOD) {
              // Get current room info to check if there are people in audience
              bot.roomInfo(false, function(roomData) {
                try {
                  const users = roomData.users || [];
                  const djs = roomData.room.metadata.djs || [];
                  const audienceCount = users.length - djs.length;
                  
                  // Only remove from queue if there are 1 or more people in audience
                  if (audienceCount >= 1 && djQueue.contains(user.name)) {
                    djQueue.remove(user.name);
                    djSongCounts.delete(user.name);
                    recentlyPlayedDJs.delete(user.name);
                    
                    console.log(`Removed ${user.name} from queue after leaving room (${audienceCount} people in audience)`);
                    
                    // Announce queue removal (second message)
                    setTimeout(() => {
                      bot.speak(`@${user.name} was removed from the DJ queue after the 30-second grace period.`);
                    }, 1000); // Small delay between messages
                    
                    // Update queue publication
                    publishQueueToRedis();
                    updateQueueSizeEnforcement();
                  } else if (audienceCount < 1) {
                    console.log(`${user.name} left but audience is empty (${audienceCount}), keeping in queue`);
                  }
                } catch (innerErr) {
                  console.error("Error checking room info for deregistered user:", innerErr);
                }
              });
              
              // Clean up the recently left list
              recentlyLeftUsers.delete(user.name);
            }
          }
        } finally {
          release();
        }
      }).catch(err => console.error("Error in deregistered timeout handler:", err));
    }, REFRESH_GRACE_PERIOD);
  } catch (error) {
    console.error("Error in deregistered handler:", error);
  }
});

// Handle DJ booth events with automatic queue management when enabled
bot.on("add_dj", function (data) {
  try {
    const user = data.user[0];

    // If queue is disabled, allow anyone to DJ without restrictions
    if (!queueEnabled) return;

    // Check if user is in cooldown period FIRST - regardless of current queue size
    if (recentlyPlayedDJs.has(user.name)) {
      const waitTime = canDJPlayAgain(user.name);
      
      // If waitTime is true, they've waited long enough
      if (waitTime !== true) {
        // They need to wait more time - remove them regardless of current queue enforcement
        bot.remDj(user.userid);
        bot.pm(
          "══════════════════\n" +
          `Wait ${waitTime} more seconds.\n` +
          "Your cooldown persists regardless of queue size changes.\n" +
          ".\n.\n.\n.\n.\n" +
          "You can hop back on the decks when ready, /q to view queue, /r to leave queue, or /usercommands for more.\n" +
          getTimestamp(),
          user.userid
        );
        console.log(`${user.name} blocked from decks - cooldown active (${waitTime}s remaining) regardless of current queue size`);
        return; // Exit early - don't process reordering for users in cooldown
      } else {
        console.log(`${user.name} cooldown has expired, allowing deck access`);
      }
    }

    mutex.acquire().then((release) => {
      try {
        // When queue is enabled, check if we need to reorder based on deck position
        if (djQueue.contains(user.name)) {
          // User is already in queue, check if deck order needs reordering
          setTimeout(() => {
            bot.roomInfo(false, function(roomData) {
              try {
                const currentDjIds = roomData?.room?.metadata?.djs || [];
                const users = roomData?.users || [];
                const currentSong = roomData?.room?.metadata?.current_song;
                
                // Get current DJs on decks in deck order
                const djsOnDecks = currentDjIds.map(id => {
                  const djUser = users.find(u => u.userid === id);
                  return djUser ? djUser.name : null;
                }).filter(Boolean);
                
                console.log(`[ADD_DJ] ${user.name} rejoined decks`);
                console.log(`[ADD_DJ] DJs on decks: ${djsOnDecks.join(', ')}`);
                console.log(`[ADD_DJ] Current queue before reorder: ${djQueue.print()}`);
                
                // Always reorder queue when someone rejoins to match deck positions
                if (djsOnDecks.length > 1) {
                  console.log(`[ADD_DJ] Reordering queue to match deck positions`);
                  
                  // Preserve song counts and users not on decks
                  const preservedSongCounts = new Map(djSongCounts);
                  const queueArray = djQueue.print() ? djQueue.print().split(', ').map(name => name.trim()) : [];
                  const usersNotOnDecks = queueArray.filter(name => !djsOnDecks.includes(name));
                  
                  // Clear and rebuild queue
                  djQueue.clear();
                  djSongCounts.clear();
                  
                  // Determine proper rotation order based on main DJ
                  let queueOrder = [];
                  
                  if (currentSong && currentSong.djid && currentSong.djname) {
                    const mainDJ = currentSong.djname;
                    const mainDJIndex = currentDjIds.indexOf(currentSong.djid);
                    
                    if (mainDJIndex !== -1 && djsOnDecks.includes(mainDJ)) {
                      // Start with main DJ
                      queueOrder.push(mainDJ);
                      
                      // Add remaining DJs in rotation order (left to right from main DJ)
                      for (let i = 1; i < currentDjIds.length; i++) {
                        const nextIndex = (mainDJIndex + i) % currentDjIds.length;
                        const nextDJId = currentDjIds[nextIndex];
                        const nextUser = users.find(u => u.userid === nextDJId);
                        
                        if (nextUser && !queueOrder.includes(nextUser.name)) {
                          queueOrder.push(nextUser.name);
                        }
                      }
                    } else {
                      // Fallback: use deck order
                      queueOrder = djsOnDecks;
                    }
                  } else {
                    // No current song, use deck order
                    queueOrder = djsOnDecks;
                  }
                  
                  // Add DJs on decks first (in rotation order)
                  queueOrder.forEach(djName => {
                    djQueue.enqueue(djName);
                    djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
                  });
                  
                  // Add users not on decks to end of queue
                  usersNotOnDecks.forEach(djName => {
                    djQueue.enqueue(djName);
                    djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
                  });
                  
                  publishQueueToRedis();
                  
                  console.log(`[ADD_DJ] Reordered queue: ${djQueue.print()}`);
                  // Only announce reordering when someone successfully secures a deck spot
                  bot.speak(`Queue reordered to match deck positions. Current rotation: ${djQueue.print()}`);
                } else {
                  // Only one DJ on decks, no reordering needed
                  bot.speak(`${user.name} joined the decks! Current queue: ${djQueue.print()}`);
                }
              } catch (err) {
                console.error("Error checking deck order:", err);
                bot.speak(`${user.name} joined the decks! Current queue: ${djQueue.print()}`);
              }
            });
          }, 1000); // Small delay to ensure deck position is updated
        } else {
          // User not in queue - add them and reorder if needed
          setTimeout(() => {
            bot.roomInfo(false, function(roomData) {
              try {
                const currentDjIds = roomData?.room?.metadata?.djs || [];
                const users = roomData?.users || [];
                const currentSong = roomData?.room?.metadata?.current_song;
                
                // Get current DJs on decks
                const djsOnDecks = currentDjIds.map(id => {
                  const djUser = users.find(u => u.userid === id);
                  return djUser ? djUser.name : null;
                }).filter(Boolean);
                
                console.log(`[ADD_DJ] ${user.name} joined decks (new to queue)`);
                console.log(`[ADD_DJ] DJs on decks: ${djsOnDecks.join(', ')}`);
                console.log(`[ADD_DJ] Current queue before adding: ${djQueue.print()}`);
                
                // If there are multiple DJs on decks, reorder entire queue
                if (djsOnDecks.length > 1) {
                  // Preserve song counts and existing queue members
                  const preservedSongCounts = new Map(djSongCounts);
                  const queueArray = djQueue.print() ? djQueue.print().split(', ').map(name => name.trim()) : [];
                  const usersNotOnDecks = queueArray.filter(name => !djsOnDecks.includes(name));
                  
                  // Clear and rebuild queue
                  djQueue.clear();
                  djSongCounts.clear();
                  
                  // Determine proper rotation order
                  let queueOrder = [];
                  
                  if (currentSong && currentSong.djid && currentSong.djname) {
                    const mainDJ = currentSong.djname;
                    const mainDJIndex = currentDjIds.indexOf(currentSong.djid);
                    
                    if (mainDJIndex !== -1 && djsOnDecks.includes(mainDJ)) {
                      // Start with main DJ
                      queueOrder.push(mainDJ);
                      
                      // Add remaining DJs in rotation order
                      for (let i = 1; i < currentDjIds.length; i++) {
                        const nextIndex = (mainDJIndex + i) % currentDjIds.length;
                        const nextDJId = currentDjIds[nextIndex];
                        const nextUser = users.find(u => u.userid === nextDJId);
                        
                        if (nextUser && !queueOrder.includes(nextUser.name)) {
                          queueOrder.push(nextUser.name);
                        }
                      }
                    } else {
                      queueOrder = djsOnDecks;
                    }
                  } else {
                    queueOrder = djsOnDecks;
                  }
                  
                  // Add DJs on decks in rotation order
                  queueOrder.forEach(djName => {
                    djQueue.enqueue(djName);
                    djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
                  });
                  
                  // Add users not on decks to end
                  usersNotOnDecks.forEach(djName => {
                    djQueue.enqueue(djName);
                    djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
                  });
                  
                  publishQueueToRedis();
                  updateQueueSizeEnforcement();
                  
                  console.log(`[ADD_DJ] Added ${user.name} and reordered queue: ${djQueue.print()}`);
                  bot.speak(`${user.name} joined the decks! Queue reordered: ${djQueue.print()}`);
                } else {
                  // Only one DJ, just add to queue
                  djQueue.enqueue(user.name);
                  resetDJSongCount(user.name);
                  publishQueueToRedis();
                  updateQueueSizeEnforcement();
                  
                  bot.speak(`${user.name} has been added to the DJ queue.`);
                }
                
                // Check if queue is now full
                if (djQueue.size() === QUEUE_FULL_SIZE) {
                  bot.speak(`DJ queue is now FULL (${QUEUE_FULL_SIZE} DJs). New users should type /a to join the queue and wait for an open spot.`);
                }
                
                // Send PM
                let message = "══════════════════\n" +
                             "You've been automatically added to the DJ queue!\n" +
                             ".\n.\n.\n.\n.\n.\n.\n" +
                             "Use /q to see the queue, /a to join if removed, /r to leave the queue.\n" + getTimestamp();
                
                bot.pm(message, user.userid);
              } catch (err) {
                console.error("Error adding new DJ:", err);
                // Fallback: simple add
                djQueue.enqueue(user.name);
                resetDJSongCount(user.name);
                publishQueueToRedis();
                bot.speak(`${user.name} has been added to the DJ queue.`);
              }
            });
          }, 1000);
        }
        
        // Check if user is in the recently played list and in cooling period
        if (recentlyPlayedDJs.has(user.name)) {
          const waitTime = canDJPlayAgain(user.name);
          
          // If waitTime is true, they've waited long enough
          if (waitTime === true) {
            // Allow them to DJ and reset their song count
            resetDJSongCount(user.name);
          } else {
            // They need to wait more time
            bot.remDj(user.userid);
            bot.pm(
              "══════════════════\n" +
              `Wait ${waitTime} more seconds.\n` +
              ".\n.\n.\n.\n.\n.\n" +
              "You can hop back on the decks when ready, /q to view queue, /r to leave queue, or /usercommands for more.\n" +
              getTimestamp(),
              user.userid
            );
          }
        }
      } finally {
        console.log("Releasing mutex after add_dj handler");
        release();
      }
    }).catch(err => console.error("Error in add_dj handler:", err));
  } catch (error) {
    console.error("Error in add_dj handler:", error);
  }
});

// Handle DJ leaving booth - keep DJs in queue unless they manually remove themselves
bot.on("rem_dj", function (data) {
  try {
    const user = data.user[0];
    
    // Only manage queue if it's enabled
    if (!queueEnabled) return;
    
    // Clean up song timing tracking when DJ leaves booth
    if (songStartTimes.has(user.name)) {
      songStartTimes.delete(user.name);
      console.log(`Cleaned up song timing for ${user.name} (left booth)`);
    }
    
    mutex.acquire().then((release) => {
      try {
        // If the user is in the queue, keep them in the queue when they step down
        if (djQueue.contains(user.name)) {
          console.log(`${user.name} left the decks but remains in the queue`);
          
          // Check if we need to reorder queue based on new deck composition
          setTimeout(() => {
            bot.roomInfo(false, function(roomData) {
              try {
                const currentDjIds = roomData?.room?.metadata?.djs || [];
                const users = roomData?.users || [];
                const currentSong = roomData?.room?.metadata?.current_song;
                
                // Get current DJs on decks
                const djsOnDecks = currentDjIds.map(id => {
                  const djUser = users.find(u => u.userid === id);
                  return djUser ? djUser.name : null;
                }).filter(Boolean);
                
                console.log(`[REM_DJ] ${user.name} left decks`);
                console.log(`[REM_DJ] DJs still on decks: ${djsOnDecks.join(', ')}`);
                console.log(`[REM_DJ] Current queue before reorder: ${djQueue.print()}`);
                
                // If there are still DJs on decks, reorder queue to match new main DJ
                if (djsOnDecks.length > 0) {
                  // Preserve song counts and users not on decks
                  const preservedSongCounts = new Map(djSongCounts);
                  const queueArray = djQueue.print() ? djQueue.print().split(', ').map(name => name.trim()) : [];
                  const usersNotOnDecks = queueArray.filter(name => !djsOnDecks.includes(name));
                  
                  // Clear and rebuild queue
                  djQueue.clear();
                  djSongCounts.clear();
                  
                  // Determine new rotation order based on who's now the main DJ
                  let queueOrder = [];
                  
                  if (currentSong && currentSong.djid && currentSong.djname && djsOnDecks.includes(currentSong.djname)) {
                    // There's still a current song with a valid main DJ
                    const mainDJ = currentSong.djname;
                    const mainDJIndex = currentDjIds.indexOf(currentSong.djid);
                    
                    if (mainDJIndex !== -1) {
                      // Start with current main DJ
                      queueOrder.push(mainDJ);
                      
                      // Add remaining DJs in rotation order
                      for (let i = 1; i < currentDjIds.length; i++) {
                        const nextIndex = (mainDJIndex + i) % currentDjIds.length;
                        const nextDJId = currentDjIds[nextIndex];
                        const nextUser = users.find(u => u.userid === nextDJId);
                        
                        if (nextUser && !queueOrder.includes(nextUser.name)) {
                          queueOrder.push(nextUser.name);
                        }
                      }
                    } else {
                      queueOrder = djsOnDecks;
                    }
                  } else {
                    // No current song or main DJ changed, use deck order
                    queueOrder = djsOnDecks;
                  }
                  
                  // Add DJs on decks in rotation order
                  queueOrder.forEach(djName => {
                    djQueue.enqueue(djName);
                    djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
                  });
                  
                  // Add users not on decks to end
                  usersNotOnDecks.forEach(djName => {
                    djQueue.enqueue(djName);
                    djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
                  });
                  
                  publishQueueToRedis();
                  
                  console.log(`[REM_DJ] Reordered queue after ${user.name} left: ${djQueue.print()}`);
                  
                  // Only announce reordering if the queue actually changed and there are still DJs
                  if (djsOnDecks.length > 0) {
                    bot.speak(`Queue reordered after ${user.name} left. Current rotation: ${djQueue.print()}`);
                  }
                } else {
                  console.log(`[REM_DJ] No DJs left on decks, queue unchanged`);
                }
              } catch (err) {
                console.error("Error reordering queue after DJ left:", err);
              }
            });
          }, 1000); // Small delay to ensure room state is updated
        }
      } finally {
        console.log("Releasing mutex after rem_dj handler");
        release();
      }
    }).catch(err => console.error("Error in rem_dj handler:", err));
  } catch (error) {
    console.error("Error in rem_dj handler:", error);
  }
});

// FIXED: Enhanced endsong handler with skip detection
bot.on("endsong", function (data) {
  try {
    // Only enforce queue rules if queue is enabled
    if (!queueEnabled) return;

    // Check if song data exists
    if (!data.room?.metadata?.current_song) {
      console.log("No current song data in endsong event");
      return;
    }

    // Add a small delay to prevent duplicate processing
    setTimeout(() => {
      mutex.acquire().then((release) => {
        try {
          const currentDJ = data.room.metadata.current_song.djname;
          const currentDJId = data.room.metadata.current_song.djid;

          console.log(`Endsong event for DJ: ${currentDJ}`);

          // NEW: Check if the song was skipped
          const songWasSkipped = wasSongSkipped(currentDJ);
          console.log(`Song was ${songWasSkipped ? 'SKIPPED' : 'played naturally'} for ${currentDJ}`);
          
          // Clean up song timing data
          if (songStartTimes.has(currentDJ)) {
            songStartTimes.delete(currentDJ);
          }

          // Check if this DJ should be removed after their song (Fair Turn System)
          if (djsToRemoveAfterSong.has(currentDJ)) {
            const removalInfo = djsToRemoveAfterSong.get(currentDJ);
            djsToRemoveAfterSong.delete(currentDJ); // Remove from tracking
            
            // Remove the DJ from decks to give others a fair turn
            bot.remDj(removalInfo.userId);
            
            const removalMessage = removalInfo.reason === 'admin_removal' 
              ? `@${currentDJ} has been removed from the decks (removed from queue by admin). Next DJ can hop up!`
              : `@${currentDJ} has been removed from the decks (left the queue). Next DJ can hop up!`;
            
            bot.speak(removalMessage);
            console.log(`Removed ${currentDJ} from decks after song (${removalInfo.reason})`);
            
            // Don't continue with other enforcement logic since we already handled this DJ
            return;
          }

          // Get room info to check other DJs and people waiting
          bot.roomInfo(false, function(roomData) {
            try {
              // Check if this DJ is still actually on the decks
              const currentDjIds = roomData.room.metadata.djs || [];
              const djStillOnDecks = currentDjIds.includes(currentDJId);
              
              // If they're not on decks anymore, someone else already handled it
              if (!djStillOnDecks) {
                return;
              }
              
              // Check if the current DJ is in the queue
              const djInQueue = djQueue.contains(currentDJ);
              
              // If the DJ is not in the queue, remove them from decks
              if (!djInQueue) {
                bot.remDj(currentDJId);
                bot.speak(`@${currentDJ} has been removed from the decks. Type /a to join the DJ queue.`);
                return;
              }
              
              // ALWAYS ROTATE DJ TO END OF QUEUE (regardless of skip or natural end)
              if (djQueue.contains(currentDJ) && djQueue.size() > 1) {
                djQueue.remove(currentDJ);
                djQueue.enqueue(currentDJ);
                console.log(`Moved ${currentDJ} to end of queue for rotation`);
                
                // Update queue publication
                publishQueueToRedis();
              }
              
              // If song was skipped, no penalties - just rotation and announcement
              if (songWasSkipped) {
                console.log(`Song was skipped for ${currentDJ}, applying rotation but no penalties`);
                bot.speak(`${currentDJ} moved to end of queue. Current rotation: ${djQueue.print()}`);
                return; // Skip penalty logic but rotation already happened
              }
              
              // PENALTY LOGIC - only applies to NATURAL song endings
              // If one song per DJ is enforced (queue size >= 6)
              if (enforceOneSongPerDJ) {
                // Increment this DJ's song count for natural endings
                const songCount = incrementDJSongCount(currentDJ);
                
                // If they've played their one allowed song naturally, apply cooldown
                if (songCount >= 1) {
                  // Reset song count now that we're applying penalties
                  resetDJSongCount(currentDJ);
                  
                  // Tell room what's happening with 1-minute wait time
                  bot.speak(`@${currentDJ} has played their song (queue has 6+ people). Moved to end of queue and must wait 1 minute before playing again.`);
                  
                  // Add them to the recently played list with timestamp and set timeout reminder
                  addToRecentlyPlayed(currentDJ, currentDJId);
                  
                  // Remove them from the deck but keep them in queue
                  setTimeout(() => {
                    bot.remDj(currentDJId);
                  }, 2000); // Give them 2 seconds to see the message before removing
                }
              } else {
                // Queue size < 6: Reset count and announce rotation (no penalties)
                resetDJSongCount(currentDJ);
                bot.speak(`${currentDJ} moved to end of queue. Current rotation: ${djQueue.print()}`);
              }
              
            } catch (innerErr) {
              console.error("Error in room info callback:", innerErr);
            }
          });
        } finally {
          console.log("Releasing mutex after endsong handler");
          release();
        }
      }).catch(err => console.error("Error in endsong handler:", err));
    }, 500); // Wait 500ms before processing
  } catch (error) {
    console.error("Error in endsong handler:", error);
  }
});

// Handle various shutdown signals
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});
process.on('SIGUSR1', () => {
  console.log('Received SIGUSR1, shutting down gracefully');
  process.exit(0);
});
process.on('SIGUSR2', () => {
  console.log('Received SIGUSR2, shutting down gracefully');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

console.log(`Bot starting... Redis integration: ${redisEnabled ? 'ENABLED' : 'DISABLED'}`);
console.log("DJ Queue System with Skip Detection - Bot error handlers registered");