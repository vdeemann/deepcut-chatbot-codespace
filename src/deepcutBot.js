// Import required modules
const Bot = require("ttapi");
const Queue = require("./queue");
const Redis = require("ioredis");
const { Mutex } = require("async-mutex");

// Initialize bot and services
const bot = new Bot(
  process.env.DEEPCUT_BOT_AUTH,
  process.env.DEEPCUT_BOT_USERID,
  process.env.DEEPCUT_BOT_ROOMID,
);
const djQueue = new Queue();
// Create separate Redis connections for publishing and subscribing
const redisPublisher = new Redis(process.env.UPSTASH_REDIS_AUTH); // For publishing
const redisSubscriber = new Redis(process.env.UPSTASH_REDIS_AUTH); // For subscribing

// MODIFIED: Track recently played DJs with timestamps
const recentlyPlayedDJs = new Map(); // Changed from Set to Map to store timestamps

// Queue state control
let queueEnabled = false;
let queueLocked = false;
let publishIntervalId = null;
const PUBLISH_INTERVAL = 10000; // 10 seconds
let lastErrorTime = 0;
const ERROR_COOLDOWN = 5000; // 5 seconds
const mutex = new Mutex();

// MODIFIED: Track DJ song counts and queue size enforcement
const QUEUE_SIZE_THRESHOLD = 6; // When queue reaches this size, enforce one song per DJ
const QUEUE_FULL_SIZE = 5; // When queue reaches this size, it's considered full
const djSongCounts = new Map(); // Track how many songs each DJ has played in their turn
let enforceOneSongPerDJ = false; // Dynamic flag based on queue size
// NEW: Add wait time constant (1 minute in milliseconds)
const DJ_WAIT_TIME = 60000; // 1 minute wait time

// Admin usernames
const adminUsers = [
  process.env.ADMIN_USERNAME_1,
  process.env.ADMIN_USERNAME_2,
  process.env.ADMIN_USERNAME_3,
];

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

// NEW: Function to handle room info requests and publish current data
function handleGetCurrentRoomInfoRequest() {
  console.log("Processing request for current room info");
  
  // Get current room information
  bot.roomInfo(false, function (data) {
    try {
      console.log("Retrieved room info for Discord bot request");
      console.log("Room data:", JSON.stringify(data, null, 2)); // Debug log
      
      if (!data || !data.room || !data.room.metadata) {
        console.log("No room data available");
        // Still publish something so Discord bot doesn't wait forever
        const fallbackSongInfo = {
          songName: "No room data",
          artist: "Unknown", 
          djName: "Unknown",
          startTime: Date.now(),
          roomName: "Unknown",
          audience: [],
          djsOnDecks: []
        };
        redisPublisher.publish("channel-2", JSON.stringify(fallbackSongInfo));
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
      
      console.log("Current song data:", data.room.metadata.current_song); // Debug log
      
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
        console.log("Processed song info:", songInfo); // Debug log
      } else {
        console.log("No current song found in room metadata");
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
      console.log("DJs on decks:", djsOnDecks); // Debug log
      console.log("Audience members:", audience); // Debug log
      
      // Publish updated song info to channel-2 using publisher connection
      redisPublisher.publish("channel-2", JSON.stringify(songInfo))
        .then(() => {
          console.log("Published fresh song info to channel-2:", JSON.stringify(songInfo));
        })
        .catch(err => {
          console.error("Redis publish error for fresh song info:", err);
        });
      
      // Also publish queue info to channel-1 using publisher connection
      const queueMessage = { 
        DJs: djQueue.print(),
        locked: queueLocked
      };
      
      redisPublisher.publish("channel-1", JSON.stringify(queueMessage))
        .then(() => {
          console.log("Published fresh queue info to channel-1:", JSON.stringify(queueMessage));
        })
        .catch(err => {
          console.error("Redis publish error for fresh queue info:", err);
        });
        
    } catch (err) {
      console.error("Error processing room info request:", err);
      // Publish fallback data so Discord bot doesn't hang
      const errorSongInfo = {
        songName: "Error retrieving data",
        artist: "Unknown", 
        djName: "Unknown",
        startTime: Date.now(),
        roomName: "Unknown",
        audience: [],
        djsOnDecks: []
      };
      redisPublisher.publish("channel-2", JSON.stringify(errorSongInfo));
    }
  });
}

// MODIFIED: Function to check and update queue size enforcement
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

// NEW: Function to check if queue is full and announce
function checkQueueFullStatus() {
  const queueSize = djQueue.size();
  if (queueSize === QUEUE_FULL_SIZE) {
    bot.speak(`DJ queue is now FULL (${QUEUE_FULL_SIZE} DJs). New users should type /a to join the queue and wait for an open spot.`);
  }
}

// NEW: Function to reset a DJ's song count
function resetDJSongCount(username) {
  djSongCounts.set(username, 0);
}

// NEW: Function to increment a DJ's song count
function incrementDJSongCount(username) {
  const currentCount = djSongCounts.get(username) || 0;
  djSongCounts.set(username, currentCount + 1);
  return currentCount + 1;
}

// NEW: Function to get a DJ's song count
function getDJSongCount(username) {
  return djSongCounts.get(username) || 0;
}

// MODIFIED: Function to add a DJ to the recently played list with timestamp and set a timer to alert them
function addToRecentlyPlayed(username, userId) {
  const now = Date.now();
  recentlyPlayedDJs.set(username, now);
  console.log(`Added ${username} to recently played list with timestamp ${now}`);
  
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

// MODIFIED: Function to check if a DJ can play again (1 minute passed)
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

// Queue publication functions
function publishQueueToRedis() {
  // Only publish when there are actual changes, not constantly
  const message = { 
    DJs: djQueue.print(),
    locked: queueLocked
  };
  redisPublisher.publish("channel-1", JSON.stringify(message))
    .then(() => {
      console.log("Published queue update to channel-1:", JSON.stringify(message));
    })
    .catch(err => {
      console.error("Redis publish error:", err);
    });
}

function updateQueuePublication() {
  // Only publish when there are actual queue changes
  publishQueueToRedis();
}

function startQueuePublication() {
  return mutex.acquire().then((release) => {
    try {
      // Remove the automatic interval publishing
      // Only publish when queue is enabled initially
      if (queueEnabled) {
        console.log("Queue publication ready (event-driven mode)");
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
      // No interval to clear anymore
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

// Clear all existing event listeners to start fresh
bot.removeAllListeners();

// Handle getting current DJs and adding them to the queue
function handleGetCurrentDjBooth(username) {
  console.log(`Admin ${username} executed /getcurrentdjbooth command`);
  
  // Only allow admins to perform this action
  if (!isAdmin(username)) {
    bot.speak(`@${username} you don't have permission to get current DJs and add them to the queue.`);
    return Promise.resolve(); // Return immediately
  }
  
  // Return a Promise that resolves when the sync is actually complete
  return new Promise((resolve) => {
    // First clear the queue to ensure we're starting fresh
    // This is a simpler approach than trying to sync existing entries
    djQueue.clear();
    console.log("Queue cleared before updating with current DJs");
    
    // Use roomInfo to get current DJs in the booth
    bot.roomInfo(false, function (data) {
      try {
        console.log("Retrieved room info for /getcurrentqueue");
        
        // Check if data and required properties exist
        if (!data || !data.room || !data.room.metadata || !data.room.metadata.djs) {
          bot.speak(`Error retrieving room data. Please try again.`);
          resolve(); // Resolve even on error
          return;
        }
        
        // Access the DJs array directly from room metadata
        const currentDjIds = data.room.metadata.djs || [];
        const users = data.users || [];
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
        
        // Find DJ names from user IDs in the booth and add them to the queue
        for (let i = 0; i < currentDjIds.length; i++) {
          const djId = currentDjIds[i];
          
          let djName = null;
          
          // Find the username associated with this ID
          for (let j = 0; j < users.length; j++) {
            if (users[j].userid === djId) {
              djName = users[j].name;
              break;
            }
          }
          
          if (djName) {
            // Add DJ to the queue
            djQueue.enqueue(djName);
            // NEW: Initialize song count for this DJ
            resetDJSongCount(djName);
            addedCount++;
            console.log(`Added DJ to queue: ${djName} (ID: ${djId})`);
          } else {
            console.log(`Could not find username for DJ ID: ${djId}`);
          }
        }
        
        // Always publish the queue since we cleared it
        publishQueueToRedis();
        
        // NEW: Check if we need to enforce one song per DJ
        updateQueueSizeEnforcement();
        
        // Build response message - FIXED: Removed @username
        let message = `DJ booth sync completed. `;
        
        if (addedCount > 0) {
          message += `Added ${addedCount} DJs to the queue. `;
        } else {
          message += `No DJs found to add to the queue. `;
        }
        
        message += `Current queue: ${djQueue.print() || "Empty"}`;
        
        // Speak the message and then resolve the Promise
        bot.speak(message);
        console.log("getcurrentdjbooth command completed successfully");
        
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
              // MODIFIED: Clear recently played map when enabling queue
              recentlyPlayedDJs.clear();
              
              speakPromise = speakAsync("Live DJ queue system is now ENABLED. Current DJs will be automatically added to the queue.")
                .then(() => {
                  // Automatically sync current DJs when enabling
                  return handleGetCurrentDjBooth(username);
                })
                .then(() => {
                  // NEW: Check queue size and announce if one-song rule is in effect
                  updateQueueSizeEnforcement();
                  
                  // NEW: Announce user commands after DJ booth sync completes
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
              // MODIFIED: Reset enforcement state and clear recently played map
              enforceOneSongPerDJ = false;
              recentlyPlayedDJs.clear();
              
              speakPromise = speakAsync("Live DJ queue system is now DISABLED.")
                .then(() => {
                  // Publish disabled status to Redis before stopping publication
                  const disabledMessage = { 
                    DJs: "disabled",
                    locked: false
                  };
                  return redisPublisher.publish("channel-1", JSON.stringify(disabledMessage))
                    .then(() => {
                      console.log("Published disabled status to channel-1:", JSON.stringify(disabledMessage));
                      release(); // Release mutex before stopping publication
                      return stopQueuePublication();
                    })
                    .catch(err => {
                      console.error("Redis publish error for disabled status:", err);
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
              // MODIFIED: Remove user from song counts tracking and recently played
              djSongCounts.delete(targetUsername);
              recentlyPlayedDJs.delete(targetUsername);
              
              speakPromise = speakAsync(`@${targetUsername} has been removed from the queue by admin @${username}`)
                .then(() => {
                  updateQueuePublication();
                  
                  // If they're currently a DJ, remove them
                  bot.roomInfo(false, function (data) {
                    const currentDjs = data.room.metadata.djs;
                    for (let i = 0; i < currentDjs.length; i++) {
                      if (currentDjs[i].name === targetUsername) {
                        bot.remDj(currentDjs[i].userid);
                        break;
                      }
                    }
                  });
                  
                  // MODIFIED: Update queue size enforcement status
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
              // MODIFIED: Initialize song count for new DJ and remove from recently played
              resetDJSongCount(targetUsername);
              recentlyPlayedDJs.delete(targetUsername); // Admins can override wait time
              
              speakPromise = speakAsync(`@${targetUsername} has been added to the live DJ queue by admin @${username}`)
                .then(() => {
                  updateQueuePublication();
                  
                  // MODIFIED: Check if we now need to enforce one song per DJ
                  updateQueueSizeEnforcement();
                  
                  // NEW: Check if queue is now full
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
              // MODIFIED: Clear all song count tracking and recently played list
              djSongCounts.clear();
              recentlyPlayedDJs.clear();
              
              speakPromise = speakAsync(`@${username} has cleared the live DJ queue.`)
                .then(() => {
                  updateQueuePublication();
                  
                  // MODIFIED: Update queue size enforcement
                  updateQueueSizeEnforcement();
                });
            } else {
              speakPromise = speakAsync("The live DJ queue is already empty.");
            }
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to clear the live DJ queue.`);
          }
          break;
          
        // MODIFIED: Reset wait timers for all DJs
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
          // We don't check recentlyPlayedDJs here since we want to keep users in the queue
          // Users are only prevented from getting on the deck, not from being in the queue
          else if (!djQueue.contains(username)) {
            djQueue.enqueue(username);
            // MODIFIED: Initialize song count for this DJ
            resetDJSongCount(username);
            
            // Choose message based on current queue size (6+ = strict mode)
            const queueMessage = djQueue.size() >= QUEUE_SIZE_THRESHOLD ? 
              `Next in line is: @${username}` : 
              `Hop up! @${username}`;
            
            speakPromise = speakAsync(queueMessage)
              .then(() => {
                // Publish queue update only when there's an actual change
                publishQueueToRedis();
                
                // MODIFIED: Check if we need to enforce one song per DJ
                updateQueueSizeEnforcement();
                
                // NEW: Check if queue is now full
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
            // MODIFIED: Remove user from song counts tracking but NOT from recently played
            djSongCounts.delete(username);
            // Note: We don't remove from recentlyPlayedDJs here so they still need to wait if they've played
            
            speakPromise = speakAsync(`@${username} will be removed from the live DJ queue after their song has played.`)
              .then(() => {
                // Publish queue update only when there's an actual change
                publishQueueToRedis();
                
                // MODIFIED: Update queue size enforcement
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
      statusMessage += `• Current Queue: ${djQueue.isEmpty() ? "Empty" : djQueue.print()}\n`;
      statusMessage += `• Live Updates: ${queueEnabled ? "EVENT-DRIVEN" : "INACTIVE"}\n`;
      
      // MODIFIED: Add queue size enforcement status
      statusMessage += `• One Song Per DJ: ${enforceOneSongPerDJ ? "ENABLED (6+ in queue)" : "DISABLED"}\n`;
      
      // MODIFIED: Add recently played DJs with wait times
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
      
      statusMessage += "Use /q to view the queue, /a to add yourself, /r to remove yourself";
      
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
• /getcurrentdjbooth - Add current DJs to the queue`;

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

// NEW: Subscribe to bot-commands channel to handle requests from Discord bot
redisSubscriber.subscribe("bot-commands", (err, count) => {
  if (err) {
    console.error("Failed to subscribe to bot-commands:", err.message);
  } else {
    console.log(`Subscribed to bot-commands channel successfully!`);
  }
});

// NEW: Handle bot command messages
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
        redisPublisher.publish("bot-commands", JSON.stringify({
          command: "pong",
          timestamp: Date.now(),
          botStatus: "online"
        }))
        .then(() => {
          console.log("Sent pong response");
        })
        .catch(err => {
          console.error("Error sending pong response:", err);
        });
      }
    } catch (e) {
      console.error("Error parsing bot command:", e);
    }
  }
});

// Handle chat commands - critical fixes to make commands work
bot.on("speak", function (data) {
  const text = data.text.trim();
  const username = data.name;

  console.log(`Received command: "${text}" from ${username}`);

  // Use simple string matching for commands instead of includes
  // This ensures more accurate command detection
  
  // Handle admin commands
  if (text === "/enablequeue" || text.endsWith(" /enablequeue")) {
    console.log("Processing enablequeue command");
    handleAdminCommand("enablequeue", username)
      .catch(err => {
        console.error("Error handling enablequeue:", err);
        // Try to speak an error message to the room
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
  
  // MODIFIED: Updated reset turns command
  if (text === "/resetturns" || text.endsWith(" /resetturns")) {
    console.log("Processing resetturns command");
    handleAdminCommand("resetturns", username)
      .catch(err => {
        console.error("Error handling resetturns:", err);
        bot.speak(`@${username}: An error occurred while processing the command. Please try again later.`);
      });
    return;
  }
  
  // Add handler for the new shutdown command
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
  
  // Add handler for the new getcurrentdjbooth command
  // MODIFIED: Direct call to handleGetCurrentDjBooth, bypassing handleAdminCommand
  if (text === "/getcurrentdjbooth" || text.endsWith(" /getcurrentdjbooth")) {
    console.log("Processing getcurrentdjbooth command");
    // Call the function directly instead of through handleAdminCommand
    handleGetCurrentDjBooth(username)
      .catch(err => {
        console.error("Error in getcurrentdjbooth command:", err);
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
      // For non-admins, don't show admin commands
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
  
  // Handle admin command to add a specific user from queue
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
  
  // Use exact command matching for regular commands
  // These are the most frequently used commands
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

// Handle new song events
bot.on("newsong", function (data) {
  // Extract relevant song information
  const songInfo = {
    songName: data.room.metadata.current_song.metadata.song,
    artist: data.room.metadata.current_song.metadata.artist,
    djName: data.room.metadata.current_song.djname,
    startTime: Date.now(),
    roomName: data.room.name,
    audience: [], // Will be populated when specifically requested
    djsOnDecks: [] // Will be populated when specifically requested
  };
  
  // Publish to Redis channel-2 using publisher connection
  redisPublisher.publish("channel-2", JSON.stringify(songInfo))
    .then(() => {
      console.log("Published song info to channel-2:", JSON.stringify(songInfo));
    })
    .catch(err => {
      console.error("Redis publish error for song info:", err);
    });
});

// NEW: Track users who left recently (for refresh detection)
const recentlyLeftUsers = new Map(); // username -> timestamp
const REFRESH_GRACE_PERIOD = 30000; // 30 seconds to rejoin before being removed from queue

// NEW: Handle user registered event to inform new users about the queue system
bot.on("registered", function (data) {
  const user = data.user[0];
  
  // Check if this is the bot itself joining
  if (user.userid === process.env.DEEPCUT_BOT_USERID) {
    bot.speak("🤖 I'm online! DJ queue system ready.");
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
      
      // Don't send PM here - we'll handle it in the main welcome logic below
      // Don't return here - we still want to send a welcome message
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
});

// NEW: Handle user leaving the room
bot.on("deregistered", function (data) {
  const user = data.user[0];
  
  // Don't announce when the bot itself leaves
  if (user.userid === process.env.DEEPCUT_BOT_USERID) {
    return;
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
                  
                  // Check current DJ booth status to see if there's an open deck spot
                  bot.roomInfo(false, function(roomData) {
                    try {
                      const currentDjIds = roomData.room.metadata.djs || [];
                      const maxDJs = 5; // Maximum DJs allowed on decks
                      
                      // Only announce if there's actually an open deck spot AND people waiting in queue
                      if (currentDjIds.length < maxDJs && djQueue.size() > 0) {
                        // Removed redundant spot announcement - turntable.fm already announces when someone leaves
                      }
                    } catch (innerErr) {
                      console.error("Error checking DJ booth status:", innerErr);
                    }
                  });
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
});

// MODIFIED: Handle DJ booth events with automatic queue management when enabled
bot.on("add_dj", function (data) {
  const user = data.user[0];

  // If queue is disabled, allow anyone to DJ without restrictions
  if (!queueEnabled) return;

  mutex.acquire().then((release) => {
    try {
      // MODIFIED: When queue is enabled, automatically add DJs to the queue
      if (!djQueue.contains(user.name)) {
        // Automatically add them to the queue
        djQueue.enqueue(user.name);
        resetDJSongCount(user.name);
        
        console.log(`Automatically added ${user.name} to queue when they joined the decks`);
        
        // Announce to chat that they were added to the queue
        bot.speak(`@${user.name} has been added to the DJ queue.`);
        
        // Update queue publication
        publishQueueToRedis();
        updateQueueSizeEnforcement();
        
        // Check if queue is now full
        if (djQueue.size() === QUEUE_FULL_SIZE) {
          bot.speak(`DJ queue is now FULL (${QUEUE_FULL_SIZE} DJs). New users should type /a to join the queue and wait for an open spot.`);
        }
        
        // MODIFIED: Send them a PM explaining the system with new format
        let message = "══════════════════\n" +
                     "You've been automatically added to the DJ queue!\n" +
                     ".\n.\n.\n.\n.\n.\n.\n" +
                     "Use /q to see the queue, /a to join if removed, /r to leave the queue.\n" + getTimestamp();
        
        bot.pm(message, user.userid);
      } else {
        // User is already in queue, so initialize or reset their song count
        resetDJSongCount(user.name);
        
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
        // Remove the one song per turn PM reminder as it's not needed
        // Users will learn the rules from chat announcements when queue size changes
      }
    } finally {
      console.log("Releasing mutex after add_dj handler");
      release();
    }
  }).catch(err => console.error("Error in add_dj handler:", err));
});

// MODIFIED: Handle DJ leaving booth - keep DJs in queue unless they manually remove themselves
bot.on("rem_dj", function (data) {
  const user = data.user[0];
  
  // Only manage queue if it's enabled
  if (!queueEnabled) return;
  
  mutex.acquire().then((release) => {
    try {
      // If the user is in the queue, keep them in the queue when they step down
      if (djQueue.contains(user.name)) {
        console.log(`${user.name} left the decks but remains in the queue`);
        
        // Check if this user recently left the room (likely a refresh)
        const isLikelyRefresh = recentlyLeftUsers.has(user.name);
        
        // Don't send PM for regular removals - only the wait time or specific messages are needed
        
        // Don't automatically remove them from the queue
        // They stay in queue until they manually use /r or an admin removes them
        
        // Check if this creates an available spot for others to join the decks
        // (announce if there are open deck spots and people waiting in queue)
        bot.roomInfo(false, function(roomData) {
          const currentDjIds = roomData.room.metadata.djs || [];
          const currentDjNames = [];
          const users = roomData.users || [];
          const maxDJs = 5; // Maximum DJs allowed on decks
          
          // Get names of current DJs
          for (const djId of currentDjIds) {
            for (const user of users) {
              if (user.userid === djId) {
                currentDjNames.push(user.name);
                break;
              }
            }
          }
          
          // Only announce if there are open deck spots
          if (currentDjIds.length < maxDJs) {
            // Find queued users who can play (not currently DJing and not in cooldown)
            const queueText = djQueue.print();
            if (queueText && queueText.trim() !== 'Empty') {
              const queuedUsers = queueText.split(', ');
              const availableUsers = [];
              
              for (const queuedUser of queuedUsers) {
                if (!currentDjNames.includes(queuedUser) && 
                    (!recentlyPlayedDJs.has(queuedUser) || canDJPlayAgain(queuedUser) === true)) {
                  availableUsers.push(queuedUser);
                }
              }
              
              if (availableUsers.length > 0) {
                // Removed redundant spot announcement
              }
            }
          }
        });
      }
    } finally {
      console.log("Releasing mutex after rem_dj handler");
      release();
    }
  }).catch(err => console.error("Error in rem_dj handler:", err));
});

// MODIFIED: Add a global "endsong" handler to check DJ status after each song with duplicate prevention
bot.on("endsong", function (data) {
  // Only enforce queue rules if queue is enabled
  if (!queueEnabled) return;

  // Add a small delay to prevent duplicate processing
  setTimeout(() => {
    mutex.acquire().then((release) => {
      try {
        const currentDJ = data.room.metadata.current_song.djname;
        const currentDJId = data.room.metadata.current_song.djid;

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
              // Simplified message - just tell them they've been removed
              bot.speak(`@${currentDJ} has been removed from the decks. Type /a to join the DJ queue.`);
              return;
            }
            
            // If one song per DJ is enforced (queue size >= 6)
            if (enforceOneSongPerDJ) {
              // Increment this DJ's song count
              const songCount = incrementDJSongCount(currentDJ);
              
              // If they've played their one allowed song, mark them as restricted but keep them in queue
              if (songCount >= 1) {
                // Tell room what's happening with 1-minute wait time
                bot.speak(`@${currentDJ} has played their song (queue has 6+ people). You're still in the queue but must wait 1 minute before playing again.`);
                
                // Add them to the recently played list with timestamp and set timeout reminder
                addToRecentlyPlayed(currentDJ, currentDJId);
                
                // Remove them from the deck but keep them in queue
                setTimeout(() => {
                  bot.remDj(currentDJId);
                  
                  // Don't send redundant PM - user already knows they were removed
                  
                  // Remind people waiting
                  const queueSize = djQueue.size();
                  if (queueSize > 0) {
                    // Get queued users by using the print() method which returns a string
                    const queueText = djQueue.print();
                    
                    // If queue is not empty
                    if (queueText && queueText.trim() !== 'Empty') {
                      // Split the queue text into individual usernames
                      const queuedUsers = queueText.split(', ');
                      
                      // Find who's waiting and CAN play (not in cooling down period)
                      const waitingUsers = [];
                      const currentDjIds = roomData.room.metadata.djs || [];
                      const currentDjNames = [];
                      
                      // Get names of current DJs
                      const users = roomData.users || [];
                      for (const djId of currentDjIds) {
                        for (const user of users) {
                          if (user.userid === djId) {
                            currentDjNames.push(user.name);
                            break;
                          }
                        }
                      }
                      
                      for (const queuedUser of queuedUsers) {
                        // Only include users who aren't currently DJing AND aren't in cooling period
                        if (!currentDjNames.includes(queuedUser) && 
                            (!recentlyPlayedDJs.has(queuedUser) || canDJPlayAgain(queuedUser) === true)) {
                          waitingUsers.push(queuedUser);
                        }
                      }
                    
                      // If we have waiting users, remind them
                      if (waitingUsers.length > 0) {
                        // Removed redundant reminder message
                      }
                    }
                  }
                }, 2000); // Give them 2 seconds to see the message before removing
              }
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
});

// Handle various shutdown signals - removed automatic shutdown messages
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

// Handle uncaught exceptions - removed automatic shutdown messages
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections - removed automatic shutdown messages
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

console.log("Bot error handlers registered");