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
async function speakAsync(message) {
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
function updateQueuePublication() {
  if (publishIntervalId) {
    publishQueueToRedis();
  }
}

function publishQueueToRedis() {
  const message = { 
    DJs: djQueue.print(),
    locked: queueLocked
  };
  redis.publish("channel-1", JSON.stringify(message));
  console.log("Published %s to %s", JSON.stringify(message), "channel-1");
}

function startQueuePublication() {
  stopQueuePublication();
  publishIntervalId = setInterval(publishQueueToRedis, PUBLISH_INTERVAL);
  console.log("Queue publication started");
}

function stopQueuePublication() {
  if (publishIntervalId) {
    clearInterval(publishIntervalId);
    publishIntervalId = null;
    console.log("Queue publication stopped");
  }
}

// Clear all existing event listeners to start fresh
bot.removeAllListeners();

// Command handler functions
async function handleAdminCommand(command, username, targetUsername = null) {
  const release = await mutex.acquire();
  try {
    switch (command) {
      case "enablequeue":
        if (isAdmin(username)) {
          queueEnabled = true;
          await speakAsync("Live DJ queue system is now ENABLED.");
          startQueuePublication();
        } else {
          await speakAsync(`@${username} you don't have permission to enable the live DJ queue.`);
        }
        break;
        
      case "disablequeue":
        if (isAdmin(username)) {
          queueEnabled = false;
          await speakAsync("Live DJ queue system is now DISABLED.");
          stopQueuePublication();
        } else {
          await speakAsync(`@${username} you don't have permission to disable the live DJ queue.`);
        }
        break;
        
      case "lockqueue":
        if (isAdmin(username)) {
          queueLocked = !queueLocked;
          await speakAsync(queueLocked 
            ? "Live DJ queue is now LOCKED. Only admins can modify the queue." 
            : "Live DJ queue is now UNLOCKED. Users can modify the queue.");
        } else {
          await speakAsync(`@${username} you don't have permission to lock/unlock the live DJ queue.`);
        }
        break;
        
      case "remove":
        if (isAdmin(username) && targetUsername) {
          if (djQueue.contains(targetUsername)) {
            djQueue.remove(targetUsername);
            await speakAsync(`@${targetUsername} has been removed from the queue by admin @${username}`);
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
          } else {
            await speakAsync(`@${username}: User "${targetUsername}" is not in the live DJ queue.`);
          }
        } else if (!targetUsername) {
          await speakAsync(`@${username}: Please specify a username to remove. Format: /@r username`);
        }
        break;
        
      case "add":
        if (isAdmin(username) && targetUsername) {
          if (!djQueue.contains(targetUsername)) {
            djQueue.enqueue(targetUsername);
            await speakAsync(`@${targetUsername} has been added to the live DJ queue by admin @${username}`);
            updateQueuePublication();
          } else {
            await speakAsync(`@${username}: User "${targetUsername}" is already in the live DJ queue.`);
          }
        } else if (!targetUsername) {
          await speakAsync(`@${username}: Please specify a username to add. Format: /@a username`);
        }
        break;
    }
  } finally {
    release();
  }
}

async function handleQueueCommand(command, username) {
  // Check if queue is disabled for regular queue commands
  if (!queueEnabled) {
    const currentTime = Date.now();
    if (currentTime - lastErrorTime > ERROR_COOLDOWN) {
      await mutex.acquire().then(async (release) => {
        await speakAsync("/q /a /r is only available when the live DJ queue is enabled by Admins");
        lastErrorTime = currentTime;
        release();
      });
    }
    return;
  }
  
  const release = await mutex.acquire();
  try {
    switch (command) {
      case "q":
        // Show queue logic - anyone can view the queue
        await speakAsync(djQueue.print());
        if (!publishIntervalId) startQueuePublication();
        break;

      case "a":
        // Add to queue logic - check if queue is locked and user is not admin
        if (queueLocked && !isAdmin(username)) {
          await speakAsync(`@${username} The queue is currently locked. Only admins can modify it.`);
        } else if (!djQueue.contains(username)) {
          djQueue.enqueue(username);
          await speakAsync(`Next in line is: @${username}`);
          updateQueuePublication();
        } else {
          await speakAsync(`You are already in the live DJ queue. @${username}`);
        }
        break;

      case "r":
        // Remove from queue logic - check if queue is locked and user is not admin
        if (queueLocked && !isAdmin(username)) {
          await speakAsync(`@${username} The queue is currently locked. Only admins can modify it.`);
        } else if (djQueue.contains(username)) {
          djQueue.remove(username);
          await speakAsync(`@${username} will be removed from the live DJ queue.`);
          updateQueuePublication();
        } else {
          await speakAsync(`You are not in the live DJ queue. @${username}`);
        }
        break;
    }
  } finally {
    release();
  }
}

// Handle chat commands
bot.on("speak", async function (data) {
  const text = data.text.trim();
  const username = data.name;

  // Handle admin commands
  if (text.includes("/enablequeue")) {
    await handleAdminCommand("enablequeue", username);
    return;
  }
  
  if (text.includes("/disablequeue")) {
    await handleAdminCommand("disablequeue", username);
    return;
  }
  
  if (text.includes("/lockqueue")) {
    await handleAdminCommand("lockqueue", username);
    return;
  }
  
  // Handle admin command to remove a specific user from queue
  if (text.includes("/@r") && isAdmin(username)) {
    const parts = text.split("/@r");
    if (parts.length > 1) {
      const targetUsername = parts[1].trim();
      await handleAdminCommand("remove", username, targetUsername);
    } else {
      await handleAdminCommand("remove", username);
    }
    return;
  }
  
  // Handle admin command to add a specific user from queue
  if (text.includes("/@a") && isAdmin(username)) {
    const parts = text.split("/@a");
    if (parts.length > 1) {
      const targetUsername = parts[1].trim();
      await handleAdminCommand("add", username, targetUsername);
    } else {
      await handleAdminCommand("add", username);
    }
    return;
  }
  
  // Simplified command parsing
  if (text.includes("/q")) await handleQueueCommand("q", username);
  if (text.includes("/a")) await handleQueueCommand("a", username);
  if (text.includes("/r")) await handleQueueCommand("r", username);
});

// Handle DJ booth events
bot.on("add_dj", function (data) {
  const user = data.user[0];

  // If queue is disabled, allow anyone to DJ
  if (!queueEnabled) return;

  if (!djQueue.contains(user.name)) {
    bot.remDj(user.userid);
    bot.pm(
      "Please type /a in chat to be added to the DJ queue, then click Play Music, " +
        "/r to be removed from the queue, or /q to list the current DJ queue",
      user.userid,
    );
  }
});

// Add a global "endsong" handler to check DJ status after each song
bot.on("endsong", function (data) {
  // Only enforce removals if queue is enabled
  if (!queueEnabled) return;

  const currentDJ = data.room.metadata.current_song.djname;
  const currentDJId = data.room.metadata.current_song.djid;

  // If the DJ is not in the queue, remove them
  if (!djQueue.contains(currentDJ)) {
    bot.remDj(currentDJId);
  }
});