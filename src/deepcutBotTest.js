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
  mutex.acquire().then((release) => {
    try {
      const message = { 
        DJs: djQueue.print(),
        locked: queueLocked
      };
      redis.publish("channel-1", JSON.stringify(message))
        .catch(err => console.error("Redis publish error:", err));
      console.log("Published %s to %s", JSON.stringify(message), "channel-1");
    } finally {
      release();
    }
  }).catch(err => console.error("Error in publishQueueToRedis:", err));
}

function updateQueuePublication() {
  if (publishIntervalId) {
    publishQueueToRedis();
  }
}

function startQueuePublication() {
  mutex.acquire().then((release) => {
    try {
      stopQueuePublication();
      publishIntervalId = setInterval(publishQueueToRedis, PUBLISH_INTERVAL);
      console.log("Queue publication started");
    } finally {
      release();
    }
  }).catch(err => console.error("Error in startQueuePublication:", err));
}

function stopQueuePublication() {
  mutex.acquire().then((release) => {
    try {
      if (publishIntervalId) {
        clearInterval(publishIntervalId);
        publishIntervalId = null;
        console.log("Queue publication stopped");
      }
    } finally {
      release();
    }
  }).catch(err => console.error("Error in stopQueuePublication:", err));
}

// Clear all existing event listeners to start fresh
bot.removeAllListeners();

// Command handler functions - Using promises instead of async/await
function handleAdminCommand(command, username, targetUsername = null) {
  return mutex.acquire().then((release) => {
    let speakPromise;
    
    try {
      switch (command) {
        case "enablequeue":
          if (isAdmin(username)) {
            queueEnabled = true;
            speakPromise = speakAsync("Live DJ queue system is now ENABLED.")
              .then(() => {
                startQueuePublication();
              });
          } else {
            speakPromise = speakAsync(`@${username} you don't have permission to enable the live DJ queue.`);
          }
          break;
          
        case "disablequeue":
          if (isAdmin(username)) {
            queueEnabled = false;
            speakPromise = speakAsync("Live DJ queue system is now DISABLED.")
              .then(() => {
                stopQueuePublication();
              });
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
          }
          break;
          
        default:
          speakPromise = Promise.resolve();
      }
      
      return speakPromise.finally(() => {
        release();
      });
    } catch (err) {
      console.error("Error in handleAdminCommand:", err);
      release();
      return Promise.reject(err);
    }
  });
}

function handleQueueCommand(command, username) {
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
          speakPromise = speakAsync(djQueue.print())
            .then(() => {
              if (!publishIntervalId) startQueuePublication();
            });
          break;

        case "a":
          // Add to queue logic - check if queue is locked and user is not admin
          if (queueLocked && !isAdmin(username)) {
            speakPromise = speakAsync(`@${username} The queue is currently locked. Only admins can modify it.`);
          } else if (!djQueue.contains(username)) {
            djQueue.enqueue(username);
            speakPromise = speakAsync(`Next in line is: @${username}`)
              .then(() => {
                updateQueuePublication();
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
                updateQueuePublication();
              });
          } else {
            speakPromise = speakAsync(`You are not in the live DJ queue. @${username}`);
          }
          break;
          
        default:
          speakPromise = Promise.resolve();
      }
      
      return speakPromise.finally(() => {
        release();
      });
    } catch (err) {
      console.error("Error in handleQueueCommand:", err);
      release();
      return Promise.reject(err);
    }
  });
}

// Handle chat commands
bot.on("speak", function (data) {
  const text = data.text.trim();
  const username = data.name;

  // Handle each command separately to prevent handling multiple commands
  
  // Handle admin commands
  if (text.includes("/enablequeue")) {
    handleAdminCommand("enablequeue", username)
      .catch(err => console.error("Error handling enablequeue:", err));
    return;
  }
  
  if (text.includes("/disablequeue")) {
    handleAdminCommand("disablequeue", username)
      .catch(err => console.error("Error handling disablequeue:", err));
    return;
  }
  
  if (text.includes("/lockqueue")) {
    handleAdminCommand("lockqueue", username)
      .catch(err => console.error("Error handling lockqueue:", err));
    return;
  }
  
  // Handle admin command to remove a specific user from queue
  if (text.includes("/@r") && isAdmin(username)) {
    const parts = text.split("/@r");
    if (parts.length > 1) {
      const targetUsername = parts[1].trim();
      handleAdminCommand("remove", username, targetUsername)
        .catch(err => console.error("Error handling admin remove:", err));
    } else {
      handleAdminCommand("remove", username)
        .catch(err => console.error("Error handling admin remove:", err));
    }
    return;
  }
  
  // Handle admin command to add a specific user from queue
  if (text.includes("/@a") && isAdmin(username)) {
    const parts = text.split("/@a");
    if (parts.length > 1) {
      const targetUsername = parts[1].trim();
      handleAdminCommand("add", username, targetUsername)
        .catch(err => console.error("Error handling admin add:", err));
    } else {
      handleAdminCommand("add", username)
        .catch(err => console.error("Error handling admin add:", err));
    }
    return;
  }
  
  // Handle regular queue commands one at a time, with explicit command checks
  if (text === "/q" || text.includes(" /q ") || text.startsWith("/q ") || text.endsWith(" /q")) {
    handleQueueCommand("q", username)
      .catch(err => console.error("Error handling queue command /q:", err));
    return;
  }
  
  if (text === "/a" || text.includes(" /a ") || text.startsWith("/a ") || text.endsWith(" /a")) {
    handleQueueCommand("a", username)
      .catch(err => console.error("Error handling queue command /a:", err));
    return;
  }
  
  if (text === "/r" || text.includes(" /r ") || text.startsWith("/r ") || text.endsWith(" /r")) {
    handleQueueCommand("r", username)
      .catch(err => console.error("Error handling queue command /r:", err));
    return;
  }
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
      release();
    }
  }).catch(err => console.error("Error in endsong handler:", err));
});