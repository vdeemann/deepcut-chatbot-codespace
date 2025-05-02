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

// Queue state control
let queueEnabled = false;
let queueLocked = false;
let publishIntervalId = null;
const PUBLISH_INTERVAL = 10000; // 10 seconds
let lastErrorTime = 0;
const ERROR_COOLDOWN = 5000; // 5 seconds
const mutex = new Mutex();

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
          addedCount++;
          console.log(`Added DJ to queue: ${djName} (ID: ${djId})`);
        } else {
          console.log(`Could not find username for DJ ID: ${djId}`);
        }
      }
      
      // Always publish the queue since we cleared it
      publishQueueToRedis();
      
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
              speakPromise = speakAsync("Live DJ queue system is now ENABLED.")
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
              speakPromise = speakAsync(`@${targetUsername} has been added to the live DJ queue by admin @${username}`)
                .then(() => {
                  updateQueuePublication();
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
              speakPromise = speakAsync(`@${username} has cleared the live DJ queue.`)
                .then(() => {
                  updateQueuePublication();
                });
            } else {
              speakPromise = speakAsync("The live DJ queue is already empty.");
            }
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to clear the live DJ queue.`);
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
          } else if (!djQueue.contains(username)) {
            djQueue.enqueue(username);
            speakPromise = speakAsync(`Next in line is: @${username}`)
              .then(() => {
                // Only update publication, don't try to start it here
                publishQueueToRedis();
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
            speakPromise = speakAsync(`@${username} will be removed from the live DJ queue.`)
              .then(() => {
                // Only update publication, don't try to start it here
                publishQueueToRedis();
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
    } else {
      handleAdminCommand("add", username)
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
      if (!djQueue.contains(user.name)) {
        bot.remDj(user.userid);
        bot.pm(
          "Please type /a in chat to be added to the DJ queue, then click Play Music, " +
            "/r to be removed from the queue, or /q to list the current DJ queue",
          user.userid,
        );
      }
    } finally {
      console.log("Releasing mutex after add_dj handler");
      release();
    }
  }).catch(err => console.error("Error in add_dj handler:", err));
});

// Add a global "endsong" handler to check DJ status after each song
bot.on("endsong", function (data) {
  // Only enforce removals if queue is enabled
  if (!queueEnabled) return;

  mutex.acquire().then((release) => {
    try {
      const currentDJ = data.room.metadata.current_song.djname;
      const currentDJId = data.room.metadata.current_song.djid;

      // If the DJ is not in the queue, remove them
      if (!djQueue.contains(currentDJ)) {
        bot.remDj(currentDJId);
      }
    } finally {
      console.log("Releasing mutex after endsong handler");
      release();
    }
  }).catch(err => console.error("Error in endsong handler:", err));
});