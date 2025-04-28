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
let queueEnabled = false; // Queue starts disabled by default
let queueLocked = false;  // Queue starts unlocked by default

// Redis publishing control
let publishIntervalId = null;
const PUBLISH_INTERVAL = 10000; // 10 seconds

// Recently sent messages tracking
let lastErrorTime = 0;
const ERROR_COOLDOWN = 5000; // 5 seconds

// Create a single mutex for DJ queue operations
const mutex = new Mutex();

// Create a wrapper for bot.speak that returns a Promise
function speakAsync(bot, message) {
  return new Promise((resolve) => {
    bot.speak(message);
    // Simulate waiting for the message to be sent
    setTimeout(resolve, 100);
  });
}

// Clear all existing event listeners to start fresh
bot.removeAllListeners();

// Handle chat commands
bot.on("speak", async function (data) {
  const text = data.text.trim();
  const username = data.name;

  // Handle admin commands first
  if (text.includes("/enablequeue")) {
    const release = await mutex.acquire();
    try {
      if (isAdmin(username)) {
        queueEnabled = true;
        await speakAsync(bot, "Live DJ queue system is now ENABLED.");
        startQueuePublication();
      } else {
        await speakAsync(
          bot,
          `@${username} you don't have permission to enable the live DJ queue.`,
        );
      }
    } finally {
      release();
    }
    return;
  }

  if (text.includes("/disablequeue")) {
    const release = await mutex.acquire();
    try {
      if (isAdmin(username)) {
        queueEnabled = false;
        await speakAsync(bot, "Live DJ queue system is now DISABLED.");
        stopQueuePublication();
      } else {
        await speakAsync(
          bot,
          `@${username} you don't have permission to disable the live DJ queue.`,
        );
      }
    } finally {
      release();
    }
    return;
  }

  // Add lockqueue command
  if (text.includes("/lockqueue")) {
    const release = await mutex.acquire();
    try {
      if (isAdmin(username)) {
        // Toggle the queue lock state
        queueLocked = !queueLocked;
        if (queueLocked) {
          await speakAsync(bot, "Live DJ queue is now LOCKED. Only admins can modify the queue.");
        } else {
          await speakAsync(bot, "Live DJ queue is now UNLOCKED. Users can modify the queue.");
        }
      } else {
        await speakAsync(
          bot,
          `@${username} you don't have permission to lock/unlock the live DJ queue.`,
        );
      }
    } finally {
      release();
    }
    return;
  }

  // Handle admin command to remove a specific user from queue
  // Format: /@r username
  if (text.includes("/@r") && isAdmin(username)) {
    const release = await mutex.acquire();
    try {
      // Extract username to remove
      const parts = text.split("/@r");
      if (parts.length > 1) {
        const targetUsername = parts[1].trim();

        if (djQueue.contains(targetUsername)) {
          djQueue.remove(targetUsername);
          await speakAsync(
            bot,
            `@${targetUsername} has been removed from the queue by admin @${username}`,
          );
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
          await speakAsync(
            bot,
            `@${username}: User "${targetUsername}" is not in the live DJ queue.`,
          );
        }
      } else {
        await speakAsync(
          bot,
          `@${username}: Please specify a username to remove. Format: /@r username`,
        );
      }
    } finally {
      release();
    }
    return;
  }

  // Handle admin command to add a specific user to queue
  // Format: /@a username
  if (text.includes("/@a") && isAdmin(username)) {
    const release = await mutex.acquire();
    try {
      // Extract username to add
      const parts = text.split("/@a");
      if (parts.length > 1) {
        const targetUsername = parts[1].trim();

        if (!djQueue.contains(targetUsername)) {
          djQueue.enqueue(targetUsername);
          await speakAsync(
            bot,
            `@${targetUsername} has been added to the live DJ queue by admin @${username}`,
          );
          updateQueuePublication();
        } else {
          await speakAsync(
            bot,
            `@${username}: User "${targetUsername}" is already in the live DJ  queue.`,
          );
        }
      } else {
        await speakAsync(
          bot,
          `@${username}: Please specify a username to add. Format: /@a username`,
        );
      }
    } finally {
      release();
    }
    return;
  }

  // Extract regular queue commands
  const commands = [];
  let pos = 0;

  while (pos < text.length) {
    const cmdIndices = [
      text.indexOf("/q", pos),
      text.indexOf("/a", pos),
      text.indexOf("/r", pos),
    ].filter((i) => i !== -1);

    if (cmdIndices.length === 0) break;

    const nextIndex = Math.min(...cmdIndices);

    if (text.startsWith("/q", nextIndex)) commands.push("q");
    else if (text.startsWith("/a", nextIndex)) commands.push("a");
    else if (text.startsWith("/r", nextIndex)) commands.push("r");

    pos = nextIndex + 2;
  }

  // Check if queue is disabled - MOVED OUTSIDE THE LOOP
  if (!queueEnabled && commands.length > 0) {
    const currentTime = Date.now();
    if (currentTime - lastErrorTime > ERROR_COOLDOWN) {
      const release = await mutex.acquire();
      try {
        await speakAsync(
          bot,
          "/q /a /r is only available when the live DJ queue is enabled by Admins",
        );
        lastErrorTime = currentTime;
      } finally {
        release();
      }
      return; // Added return to prevent processing commands when queue is disabled
    }
    return; // Exit early if queue is disabled
  }

  // Process queue commands
  for (const cmd of commands) {
    const release = await mutex.acquire();
    try {
      switch (cmd) {
        case "q":
          // Show queue logic - anyone can view the queue
          await speakAsync(bot, djQueue.print());
          if (!publishIntervalId) startQueuePublication();
          break;

        case "a":
          // Add to queue logic - check if queue is locked and user is not admin
          if (queueLocked && !isAdmin(username)) {
            await speakAsync(
              bot,
              `@${username} The queue is currently locked. Only admins can modify it.`
            );
          } else if (!djQueue.contains(username)) {
            djQueue.enqueue(username);
            await speakAsync(bot, `Next in line is: @${username}`);
            updateQueuePublication();
          } else {
            await speakAsync(
              bot,
              `You are already in the live DJ queue. @${username}`,
            );
          }
          break;

        case "r":
          // Remove from queue logic - check if queue is locked and user is not admin
          if (queueLocked && !isAdmin(username)) {
            await speakAsync(
              bot,
              `@${username} The queue is currently locked. Only admins can modify it.`
            );
          } else if (djQueue.contains(username)) {
            djQueue.remove(username);
            await speakAsync(
              bot,
              `@${username} will be removed from the live DJ queue.`,
            );
            updateQueuePublication();
          } else {
            await speakAsync(
              bot,
              `You are not in the live DJ queue. @${username}`,
            );
          }
          break;
      }
    } finally {
      release();
    }
  }
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

/**
 * Check if a user is an admin
 * @param {string} username - Username to check
 * @returns {boolean} - Whether the user is an admin
 */
function isAdmin(username) {
  console.log("Checking if user is admin:", username);

  // Define admin usernames (replace with your actual admin usernames)
  const adminUsers = [
    process.env.ADMIN_USERNAME_1,
    process.env.ADMIN_USERNAME_2,
  ];

  // Check if username is in the admin list
  const isAdminUser = adminUsers.includes(username);
  console.log("Is admin:", isAdminUser);

  return isAdminUser;
}

/**
 * Starts regular publishing of queue to Redis
 */
function startQueuePublication() {
  stopQueuePublication(); // Clear any existing interval

  publishIntervalId = setInterval(() => {
    const message = { 
      DJs: djQueue.print(),
      locked: queueLocked // Also publish the lock status
    };
    const channel = `channel-1`;
    redis.publish(channel, JSON.stringify(message));
    console.log("Published %s to %s", JSON.stringify(message), channel);
  }, PUBLISH_INTERVAL);

  console.log("Queue publication started");
}

/**
 * Stops publishing queue to Redis
 */
function stopQueuePublication() {
  if (publishIntervalId) {
    clearInterval(publishIntervalId);
    publishIntervalId = null;
    console.log("Queue publication stopped");
  }
}

/**
 * Updates queue publication with latest data
 */
function updateQueuePublication() {
  if (publishIntervalId) {
    startQueuePublication(); // Restart to publish updated queue
  }
}