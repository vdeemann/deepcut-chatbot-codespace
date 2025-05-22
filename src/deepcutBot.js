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
const redis = new Redis(process.env.UPSTASH_REDIS_AUTH);

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
zconst QUEUE_SIZE_THRESHOLD = 6; // When queue reaches this size, enforce one song per DJ
const djSongCounts = new Map(); // Track how many songs each DJ has played in their turn
let enforceOneSongPerDJ = false; // Dynamic flag based on queue size
// NEW: Add wait time constant (1 minute in milliseconds)
const DJ_WAIT_TIME = 60000; // 1 minute wait time

// Admin usernames
const adminUsers = [
  process.env.ADMIN_USERNAME_1,
  process.env.ADMIN_USERNAME_2,
];

// Helper function for bot.speak with Promise
function speakAsync(message) {
  return new Promise((resolve) => {
    bot.speak(message);
    setTimeout(resolve, 100);
  });
}

// Helper function to check if a user is an admin
function isAdmin(username) {
  return adminUsers.includes(username);
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
      
      // Send notification to the room and PM to the DJ
      bot.speak(`@${username} Your 1-minute wait time is up! You can now rejoin the decks.`);
      
      // Send PM if we have their ID
      if (userId) {
        bot.pm(
          "Your 1-minute wait time is up! You can now hop back on the decks to play your next song.",
          userId
        );
      }
      
      console.log(`${username}'s cooldown period has ended, removed from recently played list`);
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
  // Don't use mutex here to avoid potential deadlocks
  const message = { 
    DJs: djQueue.print(),
    locked: queueLocked
  };
  redis.publish("channel-1", JSON.stringify(message))
    .then(() => {
      console.log("Published %s to %s", JSON.stringify(message), "channel-1");
    })
    .catch(err => {
      console.error("Redis publish error:", err);
    });
}

function updateQueuePublication() {
  // Only publish if interval is active (indicates system is enabled)
  if (publishIntervalId) {
    publishQueueToRedis();
  }
}

function startQueuePublication() {
  return mutex.acquire().then((release) => {
    try {
      // Only start if not already running
      if (!publishIntervalId) {
        publishIntervalId = setInterval(publishQueueToRedis, PUBLISH_INTERVAL);
        console.log("Queue publication started");
        
        // Publish immediately when starting
        publishQueueToRedis();
      }
      return Promise.resolve(); // Explicitly return a resolved promise
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
      if (publishIntervalId) {
        clearInterval(publishIntervalId);
        publishIntervalId = null;
        console.log("Queue publication stopped");
      }
      return Promise.resolve(); // Explicitly return a resolved promise
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
        bot.speak(`@${username}: Error retrieving room data. Please try again.`);
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
        bot.speak(`@${username}: No DJs currently on decks. Queue is empty.`);
        console.log("No DJs in booth, queue remains empty");
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
      
      // Build response message
      let message = `@${username}: DJ booth sync completed. `;
      
      if (addedCount > 0) {
        message += `Added ${addedCount} DJs to the queue. `;
      } else {
        message += `No DJs found to add to the queue. `;
      }
      
      message += `Current queue: ${djQueue.print() || "Empty"}`;
      
      // Speak the message without returning a promise
      bot.speak(message);
      console.log("getcurrentdjbooth command completed successfully");
    } catch (innerErr) {
      console.error("Error processing room info:", innerErr);
      bot.speak(`@${username}: Error checking current DJs. Please try again.`);
    }
  });
  
  // Return a resolved promise immediately so other commands can continue
  return Promise.resolve(); 
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
              
              speakPromise = speakAsync("Live DJ queue system is now ENABLED.")
                .then(() => {
                  // NEW: Check queue size and announce if one-song rule is in effect
                  updateQueueSizeEnforcement();
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
                  release(); // Release mutex before stopping publication
                  return stopQueuePublication();
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
            
            speakPromise = speakAsync(`Next in line is: @${username}`)
              .then(() => {
                // Only update publication, don't try to start it here
                publishQueueToRedis();
                
                // MODIFIED: Check if we need to enforce one song per DJ
                updateQueueSizeEnforcement();
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
            
            speakPromise = speakAsync(`@${username} will be removed from the live DJ queue.`)
              .then(() => {
                // Only update publication, don't try to start it here
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
      statusMessage += `• Live Updates: ${publishIntervalId ? "ACTIVE" : "INACTIVE"}\n`;
      
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
      const commandsList = `
Admin Commands for DJ Queue System:
• /enablequeue - Enable the DJ queue system
• /disablequeue - Disable the DJ queue system
• /lockqueue - Toggle queue lock status (locked/unlocked)
• /clearqueue - Clear all entries from the queue
• /getcurrentdjbooth - Add current DJs to the queue
• /resetturns - Reset all DJ wait times 
• /@a [username] - Add specific user to the queue
• /@r [username] - Remove specific user from the queue
• /queuestatus - Show complete system status
      `;
      
      return speakAsync(commandsList);
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
      const commandsList = `
User Commands for DJ Queue System:
• /q - View the current DJ queue
• /a - Add yourself to the DJ queue
• /r - Remove yourself from the DJ queue
• /queuestatus - Show complete system status
• /usercommands - Display this help message
      `;
      
      return speakAsync(commandsList);
    } catch (err) {
      console.error("Error in handleUserCommandsDisplay:", err);
      return Promise.reject(err);
    } finally {
      release();
    }
  });
}

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
  if (text === "/@commands" || text.endsWith(" /@commands")) {
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
    } else {
      handleAdminCommand("remove", username)
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
    roomName: data.room.name
  };
  
  // Publish to Redis channel-2
  redis.publish("channel-2", JSON.stringify(songInfo))
    .then(() => {
      console.log("Published song info to channel-2:", JSON.stringify(songInfo));
    })
    .catch(err => {
      console.error("Redis publish error for song info:", err);
    });
});

// Handle DJ booth events
bot.on("add_dj", function (data) {
  const user = data.user[0];

  // If queue is disabled, allow anyone to DJ
  if (!queueEnabled) return;

  mutex.acquire().then((release) => {
    try {
      // MODIFIED: Check if the user is in the queue
      if (!djQueue.contains(user.name)) {
        bot.remDj(user.userid);
        bot.pm(
          "Please type /a in chat to be added to the DJ queue, then click Play Music, " +
            "/r to be removed from the queue, or /q to list the current DJ queue",
          user.userid,
        );
        
        // MODIFIED: If queue is large, also notify about one song policy
        if (enforceOneSongPerDJ) {
          setTimeout(() => {
            bot.pm(
              "Note: Queue has 6+ people, so DJs are limited to one song per turn. " + 
              "After your turn, you must wait 1 minute before rejoining the decks. You will remain in the queue.",
              user.userid
            );
          }, 1000); // Delay second message slightly
        }
      } else {
        // User is in queue, so initialize or reset their song count
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
              `You've recently played a song. Please wait ${waitTime} more seconds before rejoining the decks. You remain in the queue.`,
              user.userid
            );
          }
        }
        // MODIFIED: If queue is large, remind them about one song policy
        else if (enforceOneSongPerDJ) {
          bot.pm(
            "Queue has 6+ people, so you'll be limited to ONE song per turn. " +
            "After your song, you'll need to wait 1 minute before rejoining the decks. You will remain in the queue.",
            user.userid
          );
        }
      }
    } finally {
      console.log("Releasing mutex after add_dj handler");
      release();
    }
  }).catch(err => console.error("Error in add_dj handler:", err));
});

// MODIFIED: Add a global "endsong" handler to check DJ status after each song
bot.on("endsong", function (data) {
  // Only enforce queue rules if queue is enabled
  if (!queueEnabled) return;

  mutex.acquire().then((release) => {
    try {
      const currentDJ = data.room.metadata.current_song.djname;
      const currentDJId = data.room.metadata.current_song.djid;

      // Get room info to check other DJs and people waiting
      bot.roomInfo(false, function(roomData) {
        try {
          // Check if the current DJ is in the queue
          const djInQueue = djQueue.contains(currentDJ);
          
          // If the DJ is not in the queue, remove them
          if (!djInQueue) {
            bot.remDj(currentDJId);
            bot.speak(`@${currentDJ} has been removed from the decks (not in the queue). Type /a to join the DJ queue.`);
            return;
          }
          
          // If one song per DJ is enforced (queue size >= 6)
          if (enforceOneSongPerDJ) {
            // Increment this DJ's song count
            const songCount = incrementDJSongCount(currentDJ);
            
            // If they've played their one allowed song, mark them as restricted but keep them in queue
            if (songCount >= 1) {
              // MODIFIED: Tell room what's happening with 1-minute wait time
              bot.speak(`@${currentDJ} has played their song (queue has 6+ people). You're still in the queue but must wait 1 minute before playing again.`);
              
          // MODIFIED: Add them to the recently played list with timestamp and set timeout reminder
              addToRecentlyPlayed(currentDJ, currentDJId);
              
              // Remove them from the deck but keep them in queue
              setTimeout(() => {
                bot.remDj(currentDJId);
                
                // Send a private message reminder
                bot.pm(
                  "You've been temporarily removed from the decks but remain in the queue. " +
                  "You can return to the decks after waiting 1 minute.",
                  currentDJId
                );
                
                // Remind people waiting
                const queueSize = djQueue.size();
                if (queueSize > 0) {
                  // The djQueue doesn't have a getAll() method
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
                      bot.speak(`Reminder: @${waitingUsers.join(', @')} - there's a free spot on the decks! Hop up to play your song.`);
                    }
                  }
                }
              }, 2000); // Give them 2 seconds to see the message before removing
            }
          }
          
          // REMOVED: No longer need checkAndClearRecentlyPlayed since we use time-based restrictions
          
        } catch (innerErr) {
          console.error("Error in room info callback:", innerErr);
        }
      });
    } finally {
      console.log("Releasing mutex after endsong handler");
      release();
    }
  }).catch(err => console.error("Error in endsong handler:", err));
});