const Bot = require("ttapi");
const Queue = require("./queue");
const { Mutex } = require("async-mutex");

// Configuration Management
class Config {
  static get() {
    return {
      QUEUE_SIZE_THRESHOLD: 6,
      QUEUE_FULL_SIZE: 5,
      DJ_WAIT_TIME: 60000,
      MIN_SONG_DURATION: 30000,
      REFRESH_GRACE_PERIOD: 30000,
      ERROR_COOLDOWN: 5000,
      adminUsers: [
        process.env.ADMIN_USERNAME_1,
        process.env.ADMIN_USERNAME_2,
        process.env.ADMIN_USERNAME_3,
      ].filter(Boolean)
    };
  }
}

// Redis Service
class RedisService {
  constructor() {
    this.enabled = process.env.ENABLE_REDIS === 'true';
    this.publisher = null;
    this.subscriber = null;
    this.init();
  }

  init() {
    if (!this.enabled) {
      console.log("Redis integration disabled");
      return;
    }

    if (!process.env.UPSTASH_REDIS_AUTH) {
      console.error("ENABLE_REDIS is true but UPSTASH_REDIS_AUTH is not provided!");
      process.exit(1);
    }

    try {
      const Redis = require("ioredis");
      this.publisher = new Redis(process.env.UPSTASH_REDIS_AUTH);
      this.subscriber = new Redis(process.env.UPSTASH_REDIS_AUTH);
      console.log("Redis integration enabled");
    } catch (error) {
      console.error("Redis module not found:", error.message);
      process.exit(1);
    }
  }

  async publish(channel, data) {
    if (!this.enabled || !this.publisher) {
      console.log(`Would publish to ${channel} (Redis disabled):`, JSON.stringify(data));
      return;
    }

    try {
      await this.publisher.publish(channel, JSON.stringify(data));
      console.log(`Published to ${channel}:`, JSON.stringify(data));
    } catch (err) {
      console.error(`Redis publish error for ${channel}:`, err);
    }
  }

  subscribe(channel, callback) {
    if (!this.enabled || !this.subscriber) return;

    this.subscriber.subscribe(channel, (err, count) => {
      if (err) console.error(`Failed to subscribe to ${channel}:`, err.message);
      else console.log(`Subscribed to ${channel} successfully!`);
    });

    this.subscriber.on("message", callback);
  }
}

// State Manager for all bot state
class StateManager {
  constructor() {
    this.reset();
  }

  reset() {
    this.djQueue = new Queue();
    this.recentlyPlayedDJs = new Map();
    this.djsToRemoveAfterSong = new Map();
    this.recentlyLeftUsers = new Map();
    this.djSongCounts = new Map();
    this.songStartTimes = new Map();
    this.queueEnabled = false;
    this.queueLocked = false;
    this.enforceOneSongPerDJ = false;
    this.lastErrorTime = 0;
    this.moderatorSkippedSongs = new Set();
    this.lastSkipData = new Map(); // Track skip types for recent skips
    
    // Scheduled Removals (Version 2)
    this.scheduledForRemoval = new Set(); // DJs scheduled to be removed at deck position 1
    
    // Fair Turn System
    this.nextDJTimeout = null;
    this.currentNextDJ = null;
    this.fairTurnInProgress = false;
    this.spotAvailableStartTime = null;
  }

  // Queue operations
  addToQueue(username) {
    this.djQueue.enqueue(username);
    this.djSongCounts.set(username, 0);
  }

  removeFromQueue(username) {
    this.djQueue.remove(username);
    this.djSongCounts.delete(username);
  }

  clearQueue() {
    this.djQueue.clear();
    this.djSongCounts.clear();
    this.recentlyPlayedDJs.clear();
  }

  moveToEndOfQueue(username) {
    if (this.djQueue.contains(username) && this.djQueue.size() > 1) {
      this.djQueue.remove(username);
      this.djQueue.enqueue(username);
    }
  }

  // DJ song count management
  incrementSongCount(username) {
    const current = this.djSongCounts.get(username) || 0;
    this.djSongCounts.set(username, current + 1);
    return current + 1;
  }

  incrementSongCountSkipped(username, isModeratorSkip = true) {
    // Track that they had a turn (for queue rotation) 
    const current = this.djSongCounts.get(username) || 0;
    this.djSongCounts.set(username, current + 1);
    
    if (isModeratorSkip) {
      // Mark that this song was skipped by moderator so they shouldn't be removed from decks
      if (!this.moderatorSkippedSongs) this.moderatorSkippedSongs = new Set();
      this.moderatorSkippedSongs.add(username);
      console.log(`[MOD_SKIP] ${username} song was skipped by moderator - won't be removed from decks`);
    } else {
      // Self-skip: counts as their turn, they can be removed at deck position 1
      console.log(`[SELF_SKIP] ${username} skipped their own song - counts as their turn`);
    }
    
    return current + 1;
  }

  resetSongCount(username) {
    this.djSongCounts.set(username, 0);
    // Also clear skip tracking and removal scheduling when resetting
    if (this.moderatorSkippedSongs) {
      this.moderatorSkippedSongs.delete(username);
    }
    if (this.scheduledForRemoval) {
      this.scheduledForRemoval.delete(username);
    }
  }

  // Scheduled Removal System
  scheduleForRemoval(username, reason = "completed_turn") {
    if (!this.scheduledForRemoval) this.scheduledForRemoval = new Set();
    this.scheduledForRemoval.add(username);
    console.log(`[SCHEDULE_REMOVAL] ${username} scheduled for removal at deck position 1 (${reason})`);
    console.log(`[SCHEDULE_REMOVAL] Current scheduled list: ${Array.from(this.scheduledForRemoval).join(', ')}`);
  }

  isScheduledForRemoval(username) {
    const isScheduled = this.scheduledForRemoval && this.scheduledForRemoval.has(username);
    console.log(`[SCHEDULE_CHECK] ${username} scheduled for removal: ${isScheduled}`);
    return isScheduled;
  }

  getScheduledRemovals() {
    const scheduled = this.scheduledForRemoval ? Array.from(this.scheduledForRemoval) : [];
    console.log(`[SCHEDULE_LIST] Currently scheduled for removal: ${scheduled.join(', ')}`);
    return scheduled;
  }

  clearScheduledRemoval(username) {
    if (this.scheduledForRemoval) {
      const wasScheduled = this.scheduledForRemoval.has(username);
      this.scheduledForRemoval.delete(username);
      console.log(`[SCHEDULE_CLEAR] ${username} removal cleared (was scheduled: ${wasScheduled})`);
      console.log(`[SCHEDULE_CLEAR] Remaining scheduled: ${Array.from(this.scheduledForRemoval).join(', ')}`);
    }
  }

  wasLastSongModeratorSkipped(username) {
    return this.moderatorSkippedSongs && this.moderatorSkippedSongs.has(username);
  }

  // Enhanced skip detection that considers admin intent
  detectSkipType(currentDJ, roomData = null) {
    // Check if we have room data to determine who might have skipped
    if (roomData) {
      const currentDjIds = roomData?.room?.metadata?.djs || [];
      const users = roomData?.users || [];
      const admins = users.filter(user => Utils.isAdmin(user.name));
      
      // If there are admins in the room, we can assume intentional moderation
      if (admins.length > 0) {
        console.log(`[SKIP_DETECTION] Admins present in room: ${admins.map(a => a.name).join(', ')}`);
        // If admins are present and a skip happened, assume it's intentional
        return "intentional_moderator"; 
      }
    }
    
    // Default to unintended for protection against technical issues
    // This protects DJs when no admins are around to moderate intentionally
    return "unintended"; // "unintended", "self", "moderator", or "intentional_moderator"
  }

  // Admin can mark the skip type after it happens
  markLastSkipType(username, skipType) {
    if (!this.lastSkipData) this.lastSkipData = new Map();
    this.lastSkipData.set(username, skipType);
    console.log(`[SKIP_OVERRIDE] ${username}'s last skip marked as: ${skipType}`);
  }

  getLastSkipType(username) {
    if (!this.lastSkipData) return "unintended";
    return this.lastSkipData.get(username) || "unintended";
  }

  // Recently played management
  addToRecentlyPlayed(username, timestamp = Date.now()) {
    this.recentlyPlayedDJs.set(username, timestamp);
  }

  removeFromRecentlyPlayed(username) {
    this.recentlyPlayedDJs.delete(username);
  }

  isInCooldown(username) {
    if (!this.recentlyPlayedDJs.has(username)) return false;
    
    const timestamp = this.recentlyPlayedDJs.get(username);
    const elapsed = Date.now() - timestamp;
    
    if (elapsed >= Config.get().DJ_WAIT_TIME) {
      this.recentlyPlayedDJs.delete(username);
      return false;
    }
    
    return Math.ceil((Config.get().DJ_WAIT_TIME - elapsed) / 1000);
  }

  // Song timing
  trackSongStart(djName, expectedDuration = null) {
    const startTime = Date.now();
    const minDuration = expectedDuration ? 
      Math.min(expectedDuration * 0.8, Config.get().MIN_SONG_DURATION) : 
      Config.get().MIN_SONG_DURATION;
    
    this.songStartTimes.set(djName, { startTime, minDuration });
  }

  wasSongSkipped(djName) {
    if (!this.songStartTimes.has(djName)) return false;
    
    const { startTime, minDuration } = this.songStartTimes.get(djName);
    const duration = Date.now() - startTime;
    return duration < minDuration;
  }

  cleanupSongTracking(djName) {
    this.songStartTimes.delete(djName);
  }

  // Deck Synchronization Methods (Version 2)
  shouldRemoveDJsFromDecks() {
    if (!this.enforceOneSongPerDJ) return false;
    
    // Only remove DJs when we're back to deck position 1 (main DJ playing)
    // Check if the current main DJ (first in queue) is actually playing
    const queueArray = this.djQueue.print() ? this.djQueue.print().split(', ').map(name => name.trim()) : [];
    if (queueArray.length === 0) return false;
    
    return true; // We'll check the actual condition in the caller with room data
  }

  shouldRemoveDJsBasedOnCurrentSong(currentSong, queueArray, roomData) {
    if (!this.enforceOneSongPerDJ || !currentSong?.djname || queueArray.length === 0) {
      return false;
    }
    
    const currentlyPlayingDJ = currentSong.djname;
    const currentDjIds = roomData?.room?.metadata?.djs || [];
    const users = roomData?.users || [];
    
    // Find the deck position of the currently playing DJ
    let playingDJPosition = -1;
    for (let i = 0; i < currentDjIds.length; i++) {
      const user = users.find(u => u.userid === currentDjIds[i]);
      if (user && user.name === currentlyPlayingDJ) {
        playingDJPosition = i;
        break;
      }
    }
    
    console.log(`[DECK_SYNC] Currently playing DJ: ${currentlyPlayingDJ} at deck position: ${playingDJPosition + 1} (leftmost = 1)`);
    
    // Only remove DJs when spotlight is at deck position 1 (leftmost, index 0)
    return playingDJPosition === 0;
  }

  getDJsToRemoveFromDecks(currentDJNames, queueArray, currentSong, roomData) {
    if (!this.enforceOneSongPerDJ) return [];
    
    const djsToRemove = [];
    
    // Only proceed if we're at deck position 1 (leftmost position)
    if (!this.shouldRemoveDJsBasedOnCurrentSong(currentSong, queueArray, roomData)) {
      return djsToRemove;
    }
    
    const currentlyPlayingDJ = currentSong.djname;
    
    console.log(`[DECK_SYNC] Spotlight at deck position 1 (leftmost), executing scheduled removals`);
    console.log(`[DECK_SYNC] Current DJs on decks: ${currentDJNames.join(', ')}`);
    console.log(`[DECK_SYNC] Currently playing DJ: ${currentlyPlayingDJ}`);
    console.log(`[DECK_SYNC] Scheduled for removal: ${Array.from(this.scheduledForRemoval || []).join(', ')}`);
    
    // Execute all scheduled removals (except the currently playing DJ)
    for (const djName of currentDJNames) {
      console.log(`[DECK_SYNC] Checking ${djName} - scheduled: ${this.isScheduledForRemoval(djName)}, isPlaying: ${djName === currentlyPlayingDJ}`);
      
      // Remove if they're scheduled for removal and not the currently playing DJ
      if (this.isScheduledForRemoval(djName) && djName !== currentlyPlayingDJ) {
        djsToRemove.push(djName);
        console.log(`[DECK_SYNC] Executing scheduled removal: ${djName}`);
      } else if (djName === currentlyPlayingDJ && this.isScheduledForRemoval(djName)) {
        // Clear the playing DJ's scheduled removal since they're at position 1 now
        this.clearScheduledRemoval(djName);
        console.log(`[DECK_SYNC] Clearing ${djName}'s scheduled removal (they're at deck position 1 now)`);
      }
    }
    
    // Clear all executed removals from schedule
    djsToRemove.forEach(djName => this.clearScheduledRemoval(djName));
    
    console.log(`[DECK_SYNC] DJs to remove: ${djsToRemove.join(', ')}`);
    
    return djsToRemove;
  }

  async removeDJsFromDecks(djsToRemove, commandHandler) {
    console.log(`[DECK_SYNC] Removing DJs from decks: ${djsToRemove.join(', ')}`);
    
    for (const djName of djsToRemove) {
      // Find the user ID for this DJ
      commandHandler.bot.roomInfo(false, (roomData) => {
        try {
          const users = roomData?.users || [];
          const user = users.find(u => u.name === djName);
          
          if (user) {
            console.log(`[DECK_SYNC] Found user ${djName} with ID ${user.userid}, removing from decks`);
            commandHandler.bot.remDj(user.userid);
            console.log(`[DECK_SYNC] Removed ${djName} from decks (played 1 song)`);
          } else {
            console.error(`[DECK_SYNC] Could not find user ${djName} in room data for removal`);
          }
        } catch (error) {
          console.error(`Error removing ${djName} from decks:`, error);
        }
      });
    }
    
    // Announce the removal
    if (djsToRemove.length > 0) {
      await commandHandler.speak(`Removed ${djsToRemove.join(', ')} from decks (completed their song turns). Queue rotation continuing.`);
    }
  }

  async startDeckFillSequence(commandHandler) {
    if (!this.queueEnabled) return;
    
    // Continuously check for open spots and fill them
    this.checkAndFillOpenSpots(commandHandler);
  }

  async checkAndFillOpenSpots(commandHandler) {
    if (!this.queueEnabled) return;
    
    // Get fresh room data to see current deck state
    commandHandler.bot.roomInfo(false, async (roomData) => {
      try {
        const currentDjIds = roomData?.room?.metadata?.djs || [];
        const users = roomData?.users || [];
        const maxSpots = 5;
        
        // Get current DJs on decks
        const currentDJNames = currentDjIds.map(djId => {
          const user = users.find(u => u.userid === djId);
          return user ? user.name : null;
        }).filter(Boolean);
        
        const availableSpots = maxSpots - currentDjIds.length;
        
        if (availableSpots > 0 && !this.fairTurnInProgress) {
          console.log(`[DECK_FILL] ${availableSpots} spots available, finding next waiting DJ`);
          
          // Get queue members not currently on decks and not in cooldown
          const queueArray = this.djQueue.print() ? this.djQueue.print().split(', ').map(name => name.trim()) : [];
          const nextWaitingDJ = queueArray.find(djName => 
            !currentDJNames.includes(djName) && !this.isInCooldown(djName)
          );
          
          if (nextWaitingDJ) {
            console.log(`[DECK_FILL] Next waiting DJ: ${nextWaitingDJ}`);
            
            // Start fair turn for the next waiting DJ
            const success = this.startFairTurnSystemWithRoomData(commandHandler, roomData);
            
            if (!success) {
              console.log(`[DECK_FILL] No eligible DJs found despite having ${nextWaitingDJ} identified`);
            }
          } else {
            console.log(`[DECK_FILL] No waiting DJs available (all on decks or in cooldown)`);
            commandHandler.speak(`${availableSpots} deck spot(s) available! Anyone can hop on the decks.`);
          }
        } else if (availableSpots > 0 && this.fairTurnInProgress) {
          console.log(`[DECK_FILL] ${availableSpots} spots available but fair turn already in progress for ${this.currentNextDJ}`);
        } else {
          console.log(`[DECK_FILL] All deck spots filled (${currentDjIds.length}/${maxSpots})`);
        }
      } catch (error) {
        console.error("Error in deck fill sequence:", error);
      }
    });
  }

  // Continuously monitor for open spots
  async continuousDeckMonitoring(commandHandler) {
    if (!this.queueEnabled) return;
    
    // Set up interval to check for open spots every 10 seconds
    setInterval(() => {
      if (this.queueEnabled && !this.fairTurnInProgress) {
        this.checkAndFillOpenSpots(commandHandler);
      }
    }, 10000); // Check every 10 seconds
  }

  synchronizeDeckPositions(commandHandler, roomData) {
    const currentDjIds = roomData?.room?.metadata?.djs || [];
    const users = roomData?.users || [];
    const currentSong = roomData?.room?.metadata?.current_song;
    
    // Get current DJs on decks
    const currentDJNames = currentDjIds.map(djId => {
      const user = users.find(u => u.userid === djId);
      return user ? user.name : null;
    }).filter(Boolean);
    
    console.log(`[DECK_SYNC] Current DJs on decks: ${currentDJNames.join(', ')}`);
    console.log(`[DECK_SYNC] Current queue before sync: ${this.djQueue.print()}`);
    
    // Check if we need to synchronize based on main DJ position
    if (currentSong?.djname && currentDJNames.includes(currentSong.djname)) {
      const mainDJ = currentSong.djname;
      const queueArray = this.djQueue.print() ? this.djQueue.print().split(', ').map(name => name.trim()) : [];
      
      console.log(`[DECK_SYNC] Main DJ: ${mainDJ}, First in queue: ${queueArray[0]}`);
      
      // If main DJ is not first in queue, we need to synchronize
      if (queueArray[0] !== mainDJ) {
        console.log(`[DECK_SYNC] Main DJ ${mainDJ} is not first in queue, synchronizing...`);
        
        // Preserve current state
        const preservedSongCounts = new Map(this.djSongCounts);
        const preservedScheduled = new Set(this.scheduledForRemoval || []);
        
        // Remove main DJ from current position and put at front
        this.djQueue.remove(mainDJ);
        
        // Clear and rebuild queue with main DJ first
        const otherQueueMembers = queueArray.filter(name => name !== mainDJ);
        
        this.djQueue.clear();
        this.djSongCounts.clear();
        
        // Add main DJ first
        this.djQueue.enqueue(mainDJ);
        this.djSongCounts.set(mainDJ, preservedSongCounts.get(mainDJ) || 0);
        
        // Add other DJs on decks in deck order (excluding main DJ)
        const deckOrder = Utils.buildQueueOrder(currentDjIds, users, currentSong);
        for (const djName of deckOrder) {
          if (djName !== mainDJ && !this.djQueue.contains(djName)) {
            this.djQueue.enqueue(djName);
            this.djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
          }
        }
        
        // Add remaining queue members
        for (const djName of otherQueueMembers) {
          if (!this.djQueue.contains(djName)) {
            this.djQueue.enqueue(djName);
            this.djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
          }
        }
        
        // Restore scheduled removals
        this.scheduledForRemoval = preservedScheduled;
        
        commandHandler.updateQueuePublication();
        console.log(`[DECK_SYNC] Synchronized queue: ${this.djQueue.print()}`);
        console.log(`[DECK_SYNC] Preserved scheduled removals: ${Array.from(this.scheduledForRemoval || []).join(', ')}`);
      } else {
        console.log(`[DECK_SYNC] Queue already synchronized - main DJ ${mainDJ} is first in queue`);
      }
    }
  }

  // Fair Turn System Methods
  startFairTurnSystem(commandHandler, currentDjIds = []) {
    if (this.fairTurnInProgress || this.djQueue.isEmpty()) return;
    
    // Get the next DJ in queue who is not currently on decks
    const queueArray = this.djQueue.print() ? this.djQueue.print().split(', ').map(name => name.trim()) : [];
    
    // Find first DJ in queue who could take the spot (not on decks, not in cooldown)
    for (const djName of queueArray) {
      // Check if this DJ is not currently on decks and not in cooldown
      const isOnDecks = currentDjIds.some(djId => {
        // We need to check if this DJ name matches any current DJ
        // This is a limitation - we'll need to get user info to match properly
        return false; // For now, we'll handle this in the caller
      });
      
      if (!this.isInCooldown(djName)) {
        this.currentNextDJ = djName;
        this.fairTurnInProgress = true;
        this.spotAvailableStartTime = Date.now();
        
        console.log(`Fair Turn System: ${djName} has 1 minute to hop on decks`);
        
        // Notify the next DJ
        commandHandler.speak(`@${djName} you have 1 minute to hop on the decks! (Queue spot available)`);
        
        // Set timeout for 1 minute
        this.nextDJTimeout = setTimeout(() => {
          this.handleNextDJTimeout(commandHandler);
        }, 60000); // 1 minute
        
        break;
      }
    }
  }

  startFairTurnSystemWithRoomData(commandHandler, roomData) {
    if (this.fairTurnInProgress || this.djQueue.isEmpty()) return;
    
    const currentDjIds = roomData?.room?.metadata?.djs || [];
    const users = roomData?.users || [];
    
    // Get names of current DJs on decks
    const currentDJNames = currentDjIds.map(djId => {
      const user = users.find(u => u.userid === djId);
      return user ? user.name : null;
    }).filter(Boolean);
    
    console.log(`Fair Turn System: Current DJs on decks: ${currentDJNames.join(', ')}`);
    
    // Get the next DJ in queue who is not currently on decks
    const queueArray = this.djQueue.print() ? this.djQueue.print().split(', ').map(name => name.trim()) : [];
    
    // Find first DJ in queue who could take the spot (not on decks, not in cooldown)
    for (const djName of queueArray) {
      const isOnDecks = currentDJNames.includes(djName);
      const inCooldown = this.isInCooldown(djName);
      
      console.log(`Fair Turn System: Checking ${djName} - onDecks: ${isOnDecks}, inCooldown: ${inCooldown}`);
      
      if (!isOnDecks && !inCooldown) {
        this.currentNextDJ = djName;
        this.fairTurnInProgress = true;
        this.spotAvailableStartTime = Date.now();
        
        console.log(`Fair Turn System: ${djName} has 1 minute to hop on decks`);
        
        // Notify the next DJ
        commandHandler.speak(`@${djName} you have 1 minute to hop on the decks! (Queue spot available)`);
        
        // Set timeout for 1 minute
        this.nextDJTimeout = setTimeout(() => {
          this.handleNextDJTimeoutWithRoomCheck(commandHandler);
        }, 60000); // 1 minute
        
        return true; // Successfully started fair turn
      }
    }
    
    console.log(`Fair Turn System: No eligible DJs found in queue`);
    return false;
  }

  handleNextDJTimeoutWithRoomCheck(commandHandler) {
    if (!this.fairTurnInProgress || !this.currentNextDJ) return;
    
    console.log(`Fair Turn System: ${this.currentNextDJ} did not take the spot, moving to end of queue`);
    
    // Move the DJ who didn't take the spot to the end of the queue
    if (this.djQueue.contains(this.currentNextDJ)) {
      this.djQueue.remove(this.currentNextDJ);
      this.djQueue.enqueue(this.currentNextDJ);
      
      commandHandler.speak(`@${this.currentNextDJ} did not take the deck spot in time and has been moved to the end of the queue.`);
      commandHandler.updateQueuePublication();
    }
    
    // Reset current DJ and end this fair turn
    const previousDJ = this.currentNextDJ;
    this.currentNextDJ = null;
    this.fairTurnInProgress = false;
    this.clearNextDJTimeout();
    
    console.log(`Fair Turn System: Ended for ${previousDJ}, checking for next waiting DJ`);
    
    // Immediately check for the next waiting DJ to start a new fair turn
    setTimeout(() => {
      this.checkAndFillOpenSpots(commandHandler);
    }, 2000); // Small delay before starting next fair turn
  }

  endFairTurnSystem(commandHandler) {
    console.log(`Fair Turn System: Ended - spot now open for free-for-all`);
    
    this.fairTurnInProgress = false;
    this.currentNextDJ = null;
    this.spotAvailableStartTime = null;
    this.clearNextDJTimeout();
    
    commandHandler.speak("All queued DJs were given a chance to take the deck spot. The spot is now open for anyone to take!");
  }

  clearNextDJTimeout() {
    if (this.nextDJTimeout) {
      clearTimeout(this.nextDJTimeout);
      this.nextDJTimeout = null;
    }
  }

  djTookSpot(djName, commandHandler) {
    if (!this.fairTurnInProgress) {
      console.log(`[FAIR_TURN] djTookSpot called but no fair turn in progress`);
      return false;
    }
    
    console.log(`[FAIR_TURN] ${djName} attempting to take spot, current next DJ: ${this.currentNextDJ}`);
    
    if (this.currentNextDJ === djName) {
      // The right DJ took the spot
      console.log(`[FAIR_TURN] ${djName} successfully took their designated spot`);
      commandHandler.speak(`@${djName} has taken their queue spot on the decks!`);
      
      this.fairTurnInProgress = false;
      this.currentNextDJ = null;
      this.spotAvailableStartTime = null;
      this.clearNextDJTimeout();
      
      // Check if there are more open spots after this DJ took one
      setTimeout(() => {
        this.checkAndFillOpenSpots(commandHandler);
      }, 2000);
      
      return true; // Legitimate take
    } else {
      // Wrong DJ took the spot during fair turn period
      const queueArray = this.djQueue.print() ? this.djQueue.print().split(', ').map(name => name.trim()) : [];
      
      console.log(`[FAIR_TURN] ${djName} took spot but was not next. Queue: ${queueArray.join(', ')}`);
      
      if (queueArray.includes(djName)) {
        // DJ is in queue but not the current next DJ - this is still queue cutting, should be blocked
        console.log(`[FAIR_TURN] BLOCKING ${djName} - queue member cutting in line during fair turn`);
        
        return false; // Should be blocked - queue member cutting in line
      } else {
        // DJ is not in queue at all - definitely should be blocked
        console.log(`[FAIR_TURN] BLOCKING ${djName} - not in queue during fair turn`);
        return false;
      }
    }
  }

  isSpotReservedForQueue() {
    return this.fairTurnInProgress && this.currentNextDJ;
  }

  getCurrentNextDJ() {
    return this.currentNextDJ;
  }
}

// Utility functions
class Utils {
  static async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static getTimestamp() {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map(n => n.toString().padStart(2, '0'))
      .join(':');
    return `----------------------- ${time}`;
  }

  static isAdmin(username) {
    return Config.get().adminUsers.includes(username);
  }

  static extractSongInfo(data) {
    if (!data?.room?.metadata) {
      return {
        songName: "No room data",
        artist: "Unknown", 
        djName: "Unknown",
        startTime: Date.now(),
        roomName: "Unknown",
        audience: [],
        djsOnDecks: []
      };
    }

    const currentSong = data.room.metadata.current_song;
    const users = data.users || [];
    const currentDjIds = data.room.metadata.djs || [];
    
    const songInfo = {
      songName: currentSong?.metadata?.song || "No song playing",
      artist: currentSong?.metadata?.artist || "Unknown artist",
      djName: currentSong?.djname || "No DJ",
      startTime: currentSong?.starttime || Date.now(),
      roomName: data.room.name || "Unknown",
      audience: [],
      djsOnDecks: []
    };

    // Extract DJs and audience
    currentDjIds.forEach(djId => {
      const user = users.find(u => u.userid === djId);
      if (user) songInfo.djsOnDecks.push(user.name);
    });
    
    users.forEach(user => {
      if (!currentDjIds.includes(user.userid)) {
        songInfo.audience.push(user.name);
      }
    });

    return songInfo;
  }

  static buildQueueOrder(currentDjIds, users, currentSong) {
    const djsOnDecks = currentDjIds.map(id => {
      const user = users.find(u => u.userid === id);
      return user ? user.name : null;
    }).filter(Boolean);
    
    if (currentSong?.djid && currentSong?.djname) {
      const mainDJ = currentSong.djname;
      const mainDJIndex = currentDjIds.indexOf(currentSong.djid);
      
      if (mainDJIndex !== -1 && djsOnDecks.includes(mainDJ)) {
        const queueOrder = [mainDJ];
        
        for (let i = 1; i < currentDjIds.length; i++) {
          const nextIndex = (mainDJIndex + i) % currentDjIds.length;
          const nextDJId = currentDjIds[nextIndex];
          const nextUser = users.find(u => u.userid === nextDJId);
          
          if (nextUser && !queueOrder.includes(nextUser.name)) {
            queueOrder.push(nextUser.name);
          }
        }
        
        return queueOrder;
      }
    }
    
    return djsOnDecks;
  }
}

// Command system
class CommandHandler {
  constructor(bot, state, redis) {
    this.bot = bot;
    this.state = state;
    this.redis = redis;
    this.mutex = new Mutex();
    
    this.commands = {
      // Admin commands
      enablequeue: { handler: this.enableQueue.bind(this), adminOnly: true },
      disablequeue: { handler: this.disableQueue.bind(this), adminOnly: true },
      lockqueue: { handler: this.lockQueue.bind(this), adminOnly: true },
      clearqueue: { handler: this.clearQueue.bind(this), adminOnly: true },
      resetturns: { handler: this.resetTurns.bind(this), adminOnly: true },
      syncqueue: { handler: this.syncQueue.bind(this), adminOnly: true },
      shutdown: { handler: this.shutdown.bind(this), adminOnly: true },
      modskip: { handler: this.markLastSkipAsModerator.bind(this), adminOnly: true },
      selfskip: { handler: this.markLastSkipAsSelf.bind(this), adminOnly: true },
      forceskip: { handler: this.forceModeratorSkip.bind(this), adminOnly: true },
      
      // User commands
      q: { handler: this.showQueue.bind(this) },
      a: { handler: this.addToQueue.bind(this) },
      r: { handler: this.removeFromQueue.bind(this) },
      
      // Info commands
      queuestatus: { handler: this.showStatus.bind(this) },
      usercommands: { handler: this.showUserCommands.bind(this) },
      admincommands: { handler: this.showAdminCommands.bind(this), adminOnly: true },
      fairturn: { handler: this.showFairTurnStatus.bind(this) }
    };
  }

  async speak(message) {
    return new Promise(resolve => {
      this.bot.speak(message);
      setTimeout(resolve, 100);
    });
  }

  async handleCommand(command, username, args = []) {
    const cmd = this.commands[command];
    if (!cmd) return;

    if (cmd.adminOnly && !Utils.isAdmin(username)) {
      await this.speak(`@${username} you don't have permission to use this command.`);
      return;
    }

    try {
      await cmd.handler(username, ...args);
    } catch (error) {
      console.error(`Error handling command ${command}:`, error);
      await this.speak(`@${username}: An error occurred. Please try again.`);
    }
  }

  async handleTargetedCommand(command, username, targetUsername) {
    if (!Utils.isAdmin(username)) {
      await this.speak(`@${username} you don't have permission to use this command.`);
      return;
    }

    try {
      if (command === 'a') {
        await this.addUserToQueue(username, targetUsername);
      } else if (command === 'r') {
        await this.removeUserFromQueue(username, targetUsername);
      }
    } catch (error) {
      console.error(`Error handling targeted command:`, error);
      await this.speak(`@${username}: An error occurred. Please try again.`);
    }
  }

  // Command implementations
  async enableQueue(username) {
    if (this.state.queueEnabled) {
      return this.speak("Live DJ queue system is already enabled.");
    }

    this.state.queueEnabled = true;
    this.state.recentlyPlayedDJs.clear();
    
    await this.speak("Live DJ queue system is now ENABLED. Current DJs will be automatically added to the queue.");
    await this.syncQueue(username);
    this.updateQueueSizeEnforcement();
    
    await this.speak(
      "DJ Queue Commands:\n" +
      "• /q - View the current DJ queue\n" +
      "• /a - Add yourself to the DJ queue\n" +
      "• /r - Remove yourself from the DJ queue\n" +
      "Type /usercommands for more help!"
    );
    
    this.redis.publish("channel-1", { DJs: this.state.djQueue.print(), locked: this.state.queueLocked });
  }

  async disableQueue(username) {
    if (!this.state.queueEnabled) {
      return this.speak("Live DJ queue system is already disabled.");
    }

    this.state.queueEnabled = false;
    this.state.enforceOneSongPerDJ = false;
    this.state.recentlyPlayedDJs.clear();
    
    await this.speak("Live DJ queue system is now DISABLED.");
    this.redis.publish("channel-1", { DJs: "disabled", locked: false });
  }

  async lockQueue(username) {
    this.state.queueLocked = !this.state.queueLocked;
    await this.speak(this.state.queueLocked 
      ? "Live DJ queue is now LOCKED. Only admins can modify the queue." 
      : "Live DJ queue is now UNLOCKED. Users can modify the queue.");
  }

  async clearQueue(username) {
    if (this.state.djQueue.isEmpty()) {
      return this.speak("The live DJ queue is already empty.");
    }

    this.state.clearQueue();
    await this.speak(`@${username} has cleared the live DJ queue.`);
    this.updateQueuePublication();
    this.updateQueueSizeEnforcement();
  }

  async resetTurns(username) {
    this.state.recentlyPlayedDJs.clear();
    await this.speak(`@${username} has reset the wait time for all DJs. All DJs can now join the queue.`);
  }

  async markLastSkipAsModerator(username, targetUsername) {
    if (!targetUsername) {
      return this.speak(`@${username}: Please specify which DJ's skip was moderator-initiated. Format: /modskip username`);
    }
    
    // Mark the specified DJ's last song as moderator skipped
    if (!this.state.moderatorSkippedSongs) this.state.moderatorSkippedSongs = new Set();
    this.state.moderatorSkippedSongs.add(targetUsername);
    
    // Also update the skip type tracking
    this.state.markLastSkipType(targetUsername, "moderator");
    
    // Remove from scheduled removal if they were scheduled
    if (this.state.isScheduledForRemoval(targetUsername)) {
      this.state.clearScheduledRemoval(targetUsername);
      await this.speak(`@${username} marked ${targetUsername}'s last skip as moderator-initiated. ${targetUsername} removed from removal schedule (protected).`);
    } else {
      await this.speak(`@${username} marked ${targetUsername}'s last skip as moderator-initiated. ${targetUsername} will not be removed from decks.`);
    }
    
    console.log(`[ADMIN_CMD] ${username} marked ${targetUsername}'s skip as moderator-initiated`);
  }

  async markLastSkipAsSelf(username, targetUsername) {
    if (!targetUsername) {
      return this.speak(`@${username}: Please specify which DJ's skip was self-initiated. Format: /selfskip username`);
    }
    
    // Mark the specified DJ's last skip as self-initiated
    this.state.markLastSkipType(targetUsername, "self");
    
    // Schedule them for removal if they aren't already scheduled
    if (!this.state.isScheduledForRemoval(targetUsername) && this.state.enforceOneSongPerDJ) {
      this.state.scheduleForRemoval(targetUsername, "confirmed_self_skip");
      await this.speak(`@${username} marked ${targetUsername}'s last skip as self-initiated. ${targetUsername} scheduled for removal at leftmost deck position.`);
    } else {
      await this.speak(`@${username} marked ${targetUsername}'s last skip as self-initiated.`);
    }
    
    console.log(`[ADMIN_CMD] ${username} marked ${targetUsername}'s skip as self-initiated`);
  }

  async forceModeratorSkip(username, targetUsername) {
    if (!targetUsername) {
      return this.speak(`@${username}: Please specify which DJ to force skip as moderator action. Format: /forceskip username`);
    }
    
    // Force mark as intentional moderator skip regardless of room state
    this.state.markLastSkipType(targetUsername, "intentional_moderator");
    
    if (this.state.enforceOneSongPerDJ) {
      this.state.scheduleForRemoval(targetUsername, "forced_moderator_skip");
      await this.speak(`@${username} marked ${targetUsername}'s last skip as forced moderator action. ${targetUsername} scheduled for removal at leftmost deck position.`);
    } else {
      await this.speak(`@${username} marked ${targetUsername}'s last skip as forced moderator action.`);
    }
    
    console.log(`[ADMIN_CMD] ${username} forced ${targetUsername}'s skip to be treated as intentional moderator skip`);
  }

  async shutdown(username) {
    await this.speak("🤖 going offline. Queue system temporarily unavailable.");
    setTimeout(() => process.exit(0), 2000);
  }

  async showQueue(username) {
    if (!this.checkQueueEnabled(username)) return;
    await this.speak(this.state.djQueue.print());
  }

  async addToQueue(username) {
    if (!this.checkQueueEnabled(username)) return;
    if (this.state.queueLocked && !Utils.isAdmin(username)) {
      return this.speak(`@${username} The queue is currently locked. Only admins can modify it.`);
    }
    
    if (this.state.djQueue.contains(username)) {
      return this.speak(`You are already in the live DJ queue. @${username}`);
    }

    this.state.addToQueue(username);
    
    const message = this.state.djQueue.size() >= Config.get().QUEUE_SIZE_THRESHOLD ? 
      `Next in line is: @${username}` : `Hop up! @${username}`;
    
    await this.speak(message);
    this.updateQueuePublication();
    this.updateQueueSizeEnforcement();
    this.checkQueueFullStatus();
  }

  async removeFromQueue(username) {
    if (!this.checkQueueEnabled(username)) return;
    if (this.state.queueLocked && !Utils.isAdmin(username)) {
      return this.speak(`@${username} The queue is currently locked. Only admins can modify it.`);
    }
    
    if (!this.state.djQueue.contains(username)) {
      return this.speak(`You are not in the live DJ queue. @${username}`);
    }

    this.state.removeFromQueue(username);
    this.handleRemovalLogic(username);
    this.updateQueuePublication();
    this.updateQueueSizeEnforcement();
  }

  async syncQueue(username) {
    return new Promise(resolve => {
      this.state.djQueue.clear();
      
      this.bot.roomInfo(false, (data) => {
        try {
          if (!data?.room?.metadata?.djs) {
            this.speak("Error retrieving room data. Please try again.");
            resolve();
            return;
          }
          
          const currentDjIds = data.room.metadata.djs || [];
          const users = data.users || [];
          const currentSong = data.room.metadata.current_song;
          
          if (currentDjIds.length === 0) {
            this.updateQueuePublication();
            this.speak("No DJs currently on decks. Queue is empty.");
            resolve();
            return;
          }
          
          // Build queue order - MAIN DJ FIRST for natural synchronization
          let queueOrder = [];
          
          if (currentSong?.djid && currentSong?.djname) {
            const mainDJ = currentSong.djname;
            const mainDJIndex = currentDjIds.indexOf(currentSong.djid);
            
            if (mainDJIndex !== -1) {
              // Check if this is a natural synchronization case (main DJ at leftmost position)
              const isNaturalSync = (mainDJIndex === 0);
              
              if (isNaturalSync) {
                console.log(`[SYNC] Natural synchronization detected - main DJ ${mainDJ} at leftmost position`);
                // For natural sync, build queue with main DJ first, then deck order
                queueOrder.push(mainDJ);
                
                // Add remaining DJs in deck order (left to right, excluding main DJ)
                for (let i = 1; i < currentDjIds.length; i++) {
                  const djId = currentDjIds[i];
                  const user = users.find(u => u.userid === djId);
                  if (user && !queueOrder.includes(user.name)) {
                    queueOrder.push(user.name);
                  }
                }
              } else {
                // Standard rotation-based queue building
                queueOrder.push(mainDJ);
                
                // Add remaining DJs in rotation order
                for (let i = 1; i < currentDjIds.length; i++) {
                  const nextIndex = (mainDJIndex + i) % currentDjIds.length;
                  const djId = currentDjIds[nextIndex];
                  const user = users.find(u => u.userid === djId);
                  if (user && !queueOrder.includes(user.name)) {
                    queueOrder.push(user.name);
                  }
                }
              }
            } else {
              // Fallback: use deck order
              queueOrder = Utils.buildQueueOrder(currentDjIds, users, currentSong);
            }
          } else {
            // No current song, use deck order
            queueOrder = Utils.buildQueueOrder(currentDjIds, users, currentSong);
          }
          
          // Add DJs to queue in synchronized order
          let addedCount = 0;
          queueOrder.forEach(djName => {
            this.state.addToQueue(djName);
            addedCount++;
            console.log(`Added DJ to queue: ${djName}`);
          });
          
          this.updateQueuePublication();
          this.updateQueueSizeEnforcement();
          
          let message = `Queue sync completed. `;
          message += addedCount > 0 ? 
            `Added ${addedCount} DJs to the queue. ` : 
            `No DJs found to add to the queue. `;
          message += `Current queue: ${this.state.djQueue.print() || "Empty"}`;
          
          this.speak(message);
          
          // Check for natural synchronization after sync
          const mainDJ = queueOrder[0];
          const isNaturalSync = currentSong?.djname === mainDJ && currentDjIds.indexOf(currentSong.djid) === 0;
          
          if (isNaturalSync && this.state.enforceOneSongPerDJ) {
            console.log(`[SYNC] Natural sync confirmed - queue and deck perfectly aligned`);
            this.speak("Queue and deck positions are naturally synchronized. Natural rotation will be maintained.");
          }
          
          setTimeout(resolve, 100);
          
        } catch (err) {
          console.error("Error processing room info:", err);
          this.speak("Error checking current DJs. Please try again.");
          resolve();
        }
      });
    });
  }

  async showStatus(username) {
    let status = "DJ Queue System Status (Version 2):\n";
    status += `• Queue System: ${this.state.queueEnabled ? "ENABLED" : "DISABLED"}\n`;
    status += `• Queue Lock: ${this.state.queueLocked ? "LOCKED (admin only)" : "UNLOCKED"}\n`;
    status += `• Live Updates: ${this.state.queueEnabled ? "EVENT-DRIVEN" : "INACTIVE"}\n`;
    status += `• Redis Integration: ${this.redis.enabled ? "ENABLED" : "DISABLED"}\n`;
    status += `• One Song Per DJ: ${this.state.enforceOneSongPerDJ ? "ENABLED (6+ in queue)" : "DISABLED"}\n`;
    status += `• Fair Turn System: ${this.state.fairTurnInProgress ? `ACTIVE (${this.state.currentNextDJ} has spot)` : "INACTIVE"}\n`;
    status += `• Deck Synchronization: ${this.state.enforceOneSongPerDJ ? "ACTIVE (Main DJ first)" : "INACTIVE"}\n`;
    status += `• Current Queue: ${this.state.djQueue.isEmpty() ? "Empty" : this.state.djQueue.print()}`;
    
    if (this.state.recentlyPlayedDJs.size > 0) {
      status += "• DJs waiting to play again:\n";
      const waiting = Array.from(this.state.recentlyPlayedDJs.entries()).map(([name, timestamp]) => {
        const remaining = Math.max(0, Config.get().DJ_WAIT_TIME - (Date.now() - timestamp));
        const seconds = Math.ceil(remaining / 1000);
        return `  - ${name}: ${seconds} seconds remaining`;
      });
      status += waiting.join('\n') + '\n';
    }
    
    // Show scheduled removals for debugging
    if (this.state.enforceOneSongPerDJ && this.state.scheduledForRemoval && this.state.scheduledForRemoval.size > 0) {
      status += "• DJs Scheduled for Removal at Deck Position 1:\n";
      const scheduled = Array.from(this.state.scheduledForRemoval);
      status += `  - ${scheduled.join(', ')}\n`;
    }
    
    // Show song counts and skip status for debugging
    if (this.state.enforceOneSongPerDJ && this.state.djSongCounts.size > 0) {
      status += "• DJ Song Counts:\n";
      const songCounts = Array.from(this.state.djSongCounts.entries()).map(([name, count]) => {
        const wasModSkipped = this.state.wasLastSongModeratorSkipped(name);
        const isScheduled = this.state.isScheduledForRemoval(name);
        let statusFlags = [];
        if (wasModSkipped) statusFlags.push("moderator skipped");
        if (isScheduled) statusFlags.push("scheduled for removal");
        const flags = statusFlags.length > 0 ? ` (${statusFlags.join(', ')})` : "";
        return `  - ${name}: ${count} song(s) played${flags}`;
      });
      status += songCounts.join('\n') + '\n';
    }
    
    await this.speak(status);
  }

  async showFairTurnStatus(username) {
    let status = "Fair Turn System Status:\n";
    status += `• Active: ${this.state.fairTurnInProgress ? "YES" : "NO"}\n`;
    status += `• Current Next DJ: ${this.state.currentNextDJ || "None"}\n`;
    status += `• Spot Reserved: ${this.state.isSpotReservedForQueue() ? "YES" : "NO"}\n`;
    
    if (this.state.spotAvailableStartTime) {
      const elapsed = Date.now() - this.state.spotAvailableStartTime;
      const remaining = Math.max(0, 60000 - elapsed);
      status += `• Time Remaining: ${Math.ceil(remaining / 1000)} seconds\n`;
    }
    
    // Get current deck info
    this.bot.roomInfo(false, (roomData) => {
      try {
        const currentDjIds = roomData?.room?.metadata?.djs || [];
        const users = roomData?.users || [];
        
        const currentDJNames = currentDjIds.map(djId => {
          const user = users.find(u => u.userid === djId);
          return user ? user.name : null;
        }).filter(Boolean);
        
        status += `• Current DJs on Decks: ${currentDJNames.join(', ') || "None"}\n`;
        status += `• Deck Spots: ${currentDjIds.length}/5\n`;
        
        this.speak(status);
      } catch (error) {
        this.speak(status + "• Error getting deck info");
      }
    });
  }

  async showUserCommands(username) {
    const commands = `User Commands for DJ Queue System:
• /q - View the current DJ queue
• /a - Add yourself to the DJ queue
• /r - Remove yourself from the DJ queue
• /queuestatus - Show complete system status
• /fairturn - Show fair turn system status
• /usercommands - Display this help message`;
    
    await this.speak(commands);
  }

  async showAdminCommands(username) {
    const commands1 = `Admin Commands for DJ Queue System:
• /enablequeue - Enable the DJ queue system
• /disablequeue - Disable the DJ queue system
• /lockqueue - Toggle queue lock status (locked/unlocked)
• /clearqueue - Clear all entries from the queue
• /syncqueue - Add current DJs to the queue`;

    const commands2 = `• /resetturns - Reset all DJ wait times 
• /shutdown - Shutdown the bot
• /modskip [username] - Mark DJ's last skip as moderator-initiated
• /selfskip [username] - Mark DJ's last skip as self-initiated
• /forceskip [username] - Force mark skip as intentional moderator action
• /@a [username] - Add specific user to the queue
• /@r [username] - Remove specific user from the queue
• /queuestatus - Show complete system status`;
    
    await this.speak(commands1);
    await Utils.delay(500);
    await this.speak(commands2);
  }

  // Helper methods
  checkQueueEnabled(username) {
    if (!this.state.queueEnabled) {
      const now = Date.now();
      if (now - this.state.lastErrorTime > Config.get().ERROR_COOLDOWN) {
        this.state.lastErrorTime = now;
        this.speak("/q /a /r is only available when the live DJ queue is enabled by Admins");
      }
      return false;
    }
    return true;
  }

  updateQueueSizeEnforcement() {
    const previous = this.state.enforceOneSongPerDJ;
    this.state.enforceOneSongPerDJ = this.state.djQueue.size() >= Config.get().QUEUE_SIZE_THRESHOLD;
    
    if (previous !== this.state.enforceOneSongPerDJ && this.state.queueEnabled) {
      if (this.state.enforceOneSongPerDJ) {
        this.speak(`Queue has reached ${Config.get().QUEUE_SIZE_THRESHOLD}+ people. Each DJ will now be limited to ONE SONG PER TURN.`);
      } else {
        this.speak(`Queue is now under ${Config.get().QUEUE_SIZE_THRESHOLD} people. DJs may play multiple songs per turn.`);
      }
    }
  }

  checkQueueFullStatus() {
    if (this.state.djQueue.size() === Config.get().QUEUE_FULL_SIZE) {
      this.speak(`DJ queue is now FULL (${Config.get().QUEUE_FULL_SIZE} DJs). New users should type /a to join the queue and wait for an open spot.`);
    }
  }

  updateQueuePublication() {
    this.redis.publish("channel-1", { 
      DJs: this.state.djQueue.print(), 
      locked: this.state.queueLocked 
    });
  }

  handleRemovalLogic(username) {
    this.bot.roomInfo(false, (roomData) => {
      try {
        const currentDjIds = roomData.room.metadata.djs || [];
        const users = roomData.users || [];
        const currentSong = roomData.room.metadata.current_song;
        
        const userOnDecks = users.find(user => 
          user.name === username && currentDjIds.includes(user.userid)
        );
        
        if (userOnDecks) {
          const isCurrentlyPlaying = currentSong && currentSong.djname === username;
          
          if (isCurrentlyPlaying && this.state.enforceOneSongPerDJ) {
            this.state.addToRecentlyPlayed(username);
            this.state.djsToRemoveAfterSong.set(username, {
              userId: userOnDecks.userid,
              reason: 'self_removal_with_cooldown'
            });
            this.speak(`${username} will be removed from the queue and must wait 1 minute before rejoining.`);
          } else if (this.state.djQueue.size() > 0) {
            this.state.djsToRemoveAfterSong.set(username, {
              userId: userOnDecks.userid,
              reason: 'self_removal'
            });
            this.speak(`${username} will be removed from the live DJ queue after their song has played.`);
          }
        } else {
          this.speak(`${username} removed from the live DJ queue.`);
        }
      } catch (error) {
        console.error("Error checking DJ status for removal:", error);
        this.speak(`${username} removed from the live DJ queue.`);
      }
    });
  }

  async addUserToQueue(adminUsername, targetUsername) {
    if (!targetUsername) {
      return this.speak(`@${adminUsername}: Please specify a username to add. Format: /@a username`);
    }
    
    if (this.state.djQueue.contains(targetUsername)) {
      return this.speak(`@${adminUsername}: User "${targetUsername}" is already in the live DJ queue.`);
    }

    this.state.addToQueue(targetUsername);
    this.state.removeFromRecentlyPlayed(targetUsername);
    
    await this.speak(`@${targetUsername} has been added to the live DJ queue by admin @${adminUsername}`);
    this.updateQueuePublication();
    this.updateQueueSizeEnforcement();
    this.checkQueueFullStatus();
  }

  async removeUserFromQueue(adminUsername, targetUsername) {
    if (!targetUsername) {
      return this.speak(`@${adminUsername}: Please specify a username to remove. Format: /@r username`);
    }
    
    if (!this.state.djQueue.contains(targetUsername)) {
      return this.speak(`@${adminUsername}: User "${targetUsername}" is not in the live DJ queue.`);
    }

    this.state.removeFromQueue(targetUsername);
    this.state.removeFromRecentlyPlayed(targetUsername);
    
    // Mark for removal if currently DJing
    this.bot.roomInfo(false, (roomData) => {
      try {
        const currentDjIds = roomData.room.metadata.djs || [];
        const users = roomData.users || [];
        
        const userOnDecks = users.find(user => 
          user.name === targetUsername && currentDjIds.includes(user.userid)
        );
        
        if (userOnDecks) {
          this.state.djsToRemoveAfterSong.set(targetUsername, {
            userId: userOnDecks.userid,
            reason: 'admin_removal'
          });
        }
      } catch (error) {
        console.error("Error checking DJ status for admin removal:", error);
      }
    });
    
    await this.speak(`@${targetUsername} has been removed from the queue by admin @${adminUsername}`);
    this.updateQueuePublication();
    this.updateQueueSizeEnforcement();
  }
}

// Event Manager
class EventManager {
  constructor(bot, state, redis, commandHandler) {
    this.bot = bot;
    this.state = state;
    this.redis = redis;
    this.commandHandler = commandHandler;
    this.mutex = new Mutex();
    
    this.setupEvents();
    this.setupRedisSubscriber();
  }

  setupEvents() {
    this.bot.removeAllListeners();
    
    this.bot.on("speak", this.handleSpeak.bind(this));
    this.bot.on("newsong", this.handleNewSong.bind(this));
    this.bot.on("endsong", this.handleEndSong.bind(this));
    this.bot.on("add_dj", this.handleAddDJ.bind(this));
    this.bot.on("rem_dj", this.handleRemDJ.bind(this));
    this.bot.on("registered", this.handleUserJoin.bind(this));
    this.bot.on("deregistered", this.handleUserLeave.bind(this));
  }

  setupRedisSubscriber() {
    this.redis.subscribe("bot-commands", (channel, message) => {
      if (channel === "bot-commands") {
        try {
          const commandData = JSON.parse(message);
          this.handleBotCommand(commandData);
        } catch (e) {
          console.error("Error parsing bot command:", e);
        }
      }
    });
  }

  handleBotCommand(commandData) {
    switch (commandData.command) {
      case "getCurrentRoomInfo":
        this.handleRoomInfoRequest();
        break;
      case "ping":
        this.redis.publish("bot-commands", {
          command: "pong",
          timestamp: Date.now(),
          botStatus: "online"
        });
        break;
    }
  }

  handleRoomInfoRequest() {
    this.bot.roomInfo(false, (data) => {
      try {
        const songInfo = Utils.extractSongInfo(data);
        this.redis.publish("channel-2", songInfo);
        this.redis.publish("channel-1", { 
          DJs: this.state.djQueue.print(), 
          locked: this.state.queueLocked 
        });
      } catch (err) {
        console.error("Error processing room info request:", err);
        this.redis.publish("channel-2", {
          songName: "Error retrieving data",
          artist: "Unknown", 
          djName: "Unknown",
          startTime: Date.now(),
          roomName: "Unknown",
          audience: [],
          djsOnDecks: []
        });
      }
    });
  }

  handleSpeak(data) {
    const text = data.text.trim();
    const username = data.name;

    // Parse regular commands
    const commandMatch = text.match(/^(?:.*\s)?\/(\w+)$/);
    if (commandMatch) {
      const command = commandMatch[1];
      this.commandHandler.handleCommand(command, username);
      return;
    }

    // Parse targeted admin commands
    const targetedMatch = text.match(/\/@([ar])\s+(.+)/);
    if (targetedMatch) {
      const [, command, target] = targetedMatch;
      this.commandHandler.handleTargetedCommand(command, username, target.trim());
      return;
    }
  }

  handleNewSong(data) {
    if (!data.room?.metadata?.current_song?.metadata) return;
    
    const currentDJ = data.room.metadata.current_song.djname;
    if (currentDJ) {
      this.state.trackSongStart(currentDJ);
    }
    
    // Check for deck synchronization when a new song starts
    if (this.state.queueEnabled && this.state.enforceOneSongPerDJ) {
      this.checkForDeckSynchronization(data);
    }
    
    this.bot.roomInfo(false, (roomData) => {
      try {
        const songInfo = Utils.extractSongInfo({ 
          ...data, 
          users: roomData.users,
          room: { 
            ...data.room, 
            metadata: { 
              ...data.room.metadata, 
              djs: roomData.room?.metadata?.djs 
            } 
          }
        });
        
        this.redis.publish("channel-2", songInfo);
      } catch (error) {
        console.error("Error in newsong handler:", error);
      }
    });
  }

  checkForDeckSynchronization(songData) {
    const currentDJ = songData.room.metadata.current_song.djname;
    
    this.bot.roomInfo(false, async (roomData) => {
      try {
        const queueArray = this.state.djQueue.print() ? this.state.djQueue.print().split(', ').map(name => name.trim()) : [];
        
        if (queueArray.length === 0) return;
        
        const currentDjIds = roomData?.room?.metadata?.djs || [];
        const users = roomData?.users || [];
        
        // Get current DJs on decks for debugging
        const currentDJNames = currentDjIds.map(djId => {
          const user = users.find(u => u.userid === djId);
          return user ? user.name : null;
        }).filter(Boolean);
        
        console.log(`[DECK_SYNC_DEBUG] Current DJs on decks: ${currentDJNames.join(', ')}`);
        console.log(`[DECK_SYNC_DEBUG] Current queue: ${queueArray.join(', ')}`);
        console.log(`[DECK_SYNC_DEBUG] Scheduled for removal: ${this.state.getScheduledRemovals().join(', ')}`);
        
        // Find the deck position of the currently playing DJ
        let playingDJPosition = -1;
        for (let i = 0; i < currentDjIds.length; i++) {
          const user = users.find(u => u.userid === currentDjIds[i]);
          if (user && user.name === currentDJ) {
            playingDJPosition = i;
            break;
          }
        }
        
        console.log(`[NEW_SONG] ${currentDJ} started playing at deck position ${playingDJPosition + 1} (leftmost = 1)`);
        
        // Check if spotlight is at deck position 1 (leftmost position, index 0)
        if (playingDJPosition === 0) {
          console.log(`[DECK_SYNC] Spotlight at leftmost position (deck position 1), checking for DJs to remove`);
          
          // Synchronize deck positions first
          this.state.synchronizeDeckPositions(this.commandHandler, roomData);
          
          // Check which DJs need to be removed
          const djsToRemove = this.state.getDJsToRemoveFromDecks(currentDJNames, queueArray, songData.room.metadata.current_song, roomData);
          
          if (djsToRemove.length > 0) {
            console.log(`[DECK_SYNC] Removing DJs who completed their turns: ${djsToRemove.join(', ')}`);
            
            await this.state.removeDJsFromDecks(djsToRemove, this.commandHandler);
            
            // Start filling the deck spots after removal
            setTimeout(() => {
              this.state.startDeckFillSequence(this.commandHandler);
            }, 2000);
          } else {
            console.log(`[DECK_SYNC] No DJs need to be removed at this time`);
            console.log(`[DECK_SYNC] Current scheduled removals: ${this.state.getScheduledRemovals().join(', ')}`);
          }
        } else {
          console.log(`[DECK_SYNC] Spotlight not at leftmost position, no removals scheduled`);
        }
      } catch (error) {
        console.error("Error in deck synchronization check:", error);
      }
    });
  }

  handleEndSong(data) {
    if (!this.state.queueEnabled || !data.room?.metadata?.current_song) return;

    setTimeout(() => {
      this.mutex.acquire().then(async (release) => {
        try {
          const currentDJ = data.room.metadata.current_song.djname;
          const currentDJId = data.room.metadata.current_song.djid;

          const songWasSkipped = this.state.wasSongSkipped(currentDJ);
          this.state.cleanupSongTracking(currentDJ);

          // Handle marked removals
          if (this.state.djsToRemoveAfterSong.has(currentDJ)) {
            this.handleMarkedRemoval(currentDJ, currentDJId);
            return;
          }

          this.bot.roomInfo(false, (roomData) => {
            try {
              const currentDjIds = roomData.room.metadata.djs || [];
              const djStillOnDecks = currentDjIds.includes(currentDJId);
              
              if (!djStillOnDecks) return;
              
              const djInQueue = this.state.djQueue.contains(currentDJ);
              
              if (!djInQueue) {
                this.bot.remDj(currentDJId);
                this.commandHandler.speak(`@${currentDJ} has been removed from the decks. Type /a to join the DJ queue.`);
                return;
              }
              
              // Always rotate DJ to end of queue
              this.state.moveToEndOfQueue(currentDJ);
              this.commandHandler.updateQueuePublication();
              
              if (songWasSkipped) {
                // Enhanced skip detection with room context
                const skipType = this.state.detectSkipType(currentDJ, roomData);
                
                if (this.state.enforceOneSongPerDJ) {
                  if (skipType === "intentional_moderator") {
                    // Admin intentionally skipped: count as turn AND schedule for removal (easier testing)
                    const songCount = this.state.incrementSongCountSkipped(currentDJ, false); // false = not protected
                    this.state.scheduleForRemoval(currentDJ, "intentional_moderator_skip");
                    this.commandHandler.speak(`${currentDJ} song was intentionally skipped by moderator. Moved to end of queue and scheduled for removal at leftmost deck position (counts as their turn). Current rotation: ${this.state.djQueue.print()}`);
                    console.log(`[INTENTIONAL_MOD_SKIP] ${currentDJ} scheduled for removal - admin intent detected`);
                  } else if (skipType === "self") {
                    // Confirmed self-skip: count as turn and schedule for removal
                    const songCount = this.state.incrementSongCountSkipped(currentDJ, false);
                    this.state.scheduleForRemoval(currentDJ, "self_skip");
                    this.commandHandler.speak(`${currentDJ} skipped their own song. Moved to end of queue and scheduled for removal at leftmost deck position. Current rotation: ${this.state.djQueue.print()}`);
                  } else {
                    // Unintended skip (no admins present): count as turn but NO removal, NO penalty
                    const songCount = this.state.incrementSongCountSkipped(currentDJ, true); // true = protected
                    this.commandHandler.speak(`${currentDJ} song was skipped (likely unintended). Moved to end of queue but remains on decks (no penalty for technical issues). Current rotation: ${this.state.djQueue.print()}`);
                    console.log(`[UNINTENDED_SKIP] ${currentDJ} protected from penalty (no admins present - assumed technical issue)`);
                  }
                } else {
                  this.commandHandler.speak(`${currentDJ} moved to end of queue. Current rotation: ${this.state.djQueue.print()}`);
                }
                return;
              }
              
              // Apply penalties only for natural endings
              if (this.state.enforceOneSongPerDJ) {
                const songCount = this.state.incrementSongCount(currentDJ);
                
                if (songCount >= 1) {
                  this.state.resetSongCount(currentDJ);
                  
                  // Schedule DJ for removal at deck position 1 (NO immediate removal)
                  this.state.scheduleForRemoval(currentDJ, "completed_natural_song");
                  
                  this.commandHandler.speak(`@${currentDJ} has played their song (queue has 6+ people). Moved to end of queue and scheduled for removal at leftmost deck position.`);
                  this.addDJToCooldown(currentDJ, currentDJId);
                  
                  // NO IMMEDIATE REMOVAL - let them stay on decks until leftmost position
                  console.log(`[SONG_END] ${currentDJ} scheduled for removal but stays on decks until leftmost position`);
                }
              } else {
                this.state.resetSongCount(currentDJ);
                this.commandHandler.speak(`${currentDJ} moved to end of queue. Current rotation: ${this.state.djQueue.print()}`);
              }
              
            } catch (innerErr) {
              console.error("Error in room info callback:", innerErr);
            }
          });
        } finally {
          release();
        }
      });
    }, 500);
  }

  checkForOpenSpotAndStartFairTurn() {
    if (!this.state.queueEnabled || this.state.fairTurnInProgress) return;
    
    this.bot.roomInfo(false, (roomData) => {
      try {
        const currentDjIds = roomData?.room?.metadata?.djs || [];
        const maxSpots = 5; // Turntable.fm allows up to 5 DJs
        
        console.log(`Checking for open spots: ${currentDjIds.length}/${maxSpots} occupied`);
        
        // If there's an open spot and people in queue, start fair turn system
        if (currentDjIds.length < maxSpots && !this.state.djQueue.isEmpty()) {
          console.log(`Open DJ spot detected (${currentDjIds.length}/${maxSpots} occupied), starting fair turn system`);
          
          const success = this.state.startFairTurnSystemWithRoomData(this.commandHandler, roomData);
          if (!success) {
            console.log(`Fair Turn System: No eligible DJs found, spot remains open for free-for-all`);
            this.commandHandler.speak("No eligible queued DJs available. Deck spot is open for anyone to take!");
          }
        } else if (currentDjIds.length >= maxSpots) {
          console.log(`No open spots available (${currentDjIds.length}/${maxSpots})`);
        } else if (this.state.djQueue.isEmpty()) {
          console.log(`Queue is empty, no fair turn needed`);
        }
      } catch (error) {
        console.error("Error checking for open spots:", error);
      }
    });
  }

  handleMarkedRemoval(currentDJ, currentDJId) {
    const removalInfo = this.state.djsToRemoveAfterSong.get(currentDJ);
    this.state.djsToRemoveAfterSong.delete(currentDJ);
    
    // Instead of immediate removal, schedule for leftmost position removal
    if (removalInfo.reason === 'admin_removal') {
      this.state.scheduleForRemoval(currentDJ, "admin_removal");
      this.commandHandler.speak(`@${currentDJ} removed from queue by admin. Scheduled for removal at leftmost deck position.`);
    } else {
      this.state.scheduleForRemoval(currentDJ, "self_removal");  
      this.commandHandler.speak(`@${currentDJ} left the queue. Scheduled for removal at leftmost deck position.`);
    }
    
    console.log(`[MARKED_REMOVAL] ${currentDJ} scheduled for removal but stays on decks until leftmost position`);
  }

  addDJToCooldown(username, userId) {
    this.state.addToRecentlyPlayed(username);
    
    setTimeout(() => {
      if (this.state.recentlyPlayedDJs.has(username)) {
        this.state.removeFromRecentlyPlayed(username);
        this.bot.pm(
          "══════════════════\n" +
          "Your 1-minute wait time is up!\n" +
          "You can now rejoin the decks.\n" +
          ".\n.\n.\n.\n.\n" +
          "Use /q to view queue, /a to join if removed, or /usercommands for more.\n" +
          Utils.getTimestamp(),
          userId
        );
      }
    }, Config.get().DJ_WAIT_TIME);
  }

  handleAddDJ(data) {
    if (!this.state.queueEnabled) return;

    const user = data.user[0];
    
    console.log(`[ADD_DJ] ${user.name} attempting to join decks`);
    console.log(`[ADD_DJ] Fair turn in progress: ${this.state.fairTurnInProgress}`);
    console.log(`[ADD_DJ] Current next DJ: ${this.state.currentNextDJ}`);
    
    // Check if fair turn system is in progress
    if (this.state.isSpotReservedForQueue()) {
      console.log(`[ADD_DJ] Spot is reserved for queue during fair turn`);
      
      const result = this.state.djTookSpot(user.name, this.commandHandler);
      
      if (!result) {
        // DJ is not in queue and took spot during fair turn period - BLOCK THEM
        console.log(`[ADD_DJ] BLOCKING ${user.name} - not in queue during fair turn`);
        this.bot.remDj(user.userid);
        
        const remainingTime = this.state.spotAvailableStartTime ? 
          Math.ceil((60000 - (Date.now() - this.state.spotAvailableStartTime)) / 1000) : 60;
        
        this.commandHandler.speak(`@${user.name} the deck spot is currently reserved for queue members. @${this.state.getCurrentNextDJ()} has the spot for ${remainingTime} more seconds.`);
        return;
      } else {
        // DJ took spot legitimately (either correct DJ or queue member out of turn)
        console.log(`[ADD_DJ] ${user.name} took spot legitimately during fair turn`);
      }
    }
    
    const cooldownTime = this.state.isInCooldown(user.name);

    if (cooldownTime) {
      console.log(`[ADD_DJ] BLOCKING ${user.name} - in cooldown (${cooldownTime}s remaining)`);
      this.bot.remDj(user.userid);
      this.bot.pm(
        "══════════════════\n" +
        `Wait ${cooldownTime} more seconds.\n` +
        "Your cooldown persists regardless of queue size changes.\n" +
        ".\n.\n.\n.\n.\n" +
        "You can hop back on the decks when ready, /q to view queue, /r to leave queue, or /usercommands for more.\n" +
        Utils.getTimestamp(),
        user.userid
      );
      return;
    }

    this.mutex.acquire().then((release) => {
      try {
        setTimeout(() => {
          this.bot.roomInfo(false, (roomData) => {
            try {
              this.handleDJReordering(user, roomData);
            } catch (err) {
              console.error("Error checking deck order:", err);
              this.commandHandler.speak(`${user.name} joined the decks! Current queue: ${this.state.djQueue.print()}`);
            }
          });
        }, 1000);
      } finally {
        release();
      }
    });
  }

  handleDJReordering(user, roomData) {
    const currentDjIds = roomData?.room?.metadata?.djs || [];
    const users = roomData?.users || [];
    const currentSong = roomData?.room?.metadata?.current_song;
    
    const djsOnDecks = currentDjIds.map(id => {
      const djUser = users.find(u => u.userid === id);
      return djUser ? djUser.name : null;
    }).filter(Boolean);
    
    if (djsOnDecks.length > 1) {
      this.reorderQueueForDeckPosition(djsOnDecks, currentDjIds, users, currentSong);
      this.commandHandler.speak(`${user.name} joined the decks! Queue reordered: ${this.state.djQueue.print()}`);
    } else {
      if (!this.state.djQueue.contains(user.name)) {
        this.state.addToQueue(user.name);
        this.commandHandler.updateQueuePublication();
        this.commandHandler.updateQueueSizeEnforcement();
        this.commandHandler.checkQueueFullStatus();
        
        this.bot.pm(
          "══════════════════\n" +
          "You've been automatically added to the DJ queue!\n" +
          ".\n.\n.\n.\n.\n.\n.\n" +
          "Use /q to see the queue, /a to join if removed, /r to leave the queue.\n" + 
          Utils.getTimestamp(),
          user.userid
        );
      }
      this.commandHandler.speak(`${user.name} joined the decks! Current queue: ${this.state.djQueue.print()}`);
    }
  }

  reorderQueueForDeckPosition(djsOnDecks, currentDjIds, users, currentSong) {
    const preservedSongCounts = new Map(this.state.djSongCounts);
    const queueArray = this.state.djQueue.print() ? this.state.djQueue.print().split(', ').map(name => name.trim()) : [];
    const usersNotOnDecks = queueArray.filter(name => !djsOnDecks.includes(name));
    
    console.log(`[REORDER] DJs on decks: ${djsOnDecks.join(', ')}`);
    console.log(`[REORDER] Users not on decks: ${usersNotOnDecks.join(', ')}`);
    
    this.state.djQueue.clear();
    this.state.djSongCounts.clear();
    
    const queueOrder = Utils.buildQueueOrder(currentDjIds, users, currentSong);
    
    console.log(`[REORDER] New queue order from deck positions: ${queueOrder.join(', ')}`);
    
    // Add DJs on decks in rotation order
    queueOrder.forEach(djName => {
      this.state.djQueue.enqueue(djName);
      this.state.djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
    });
    
    // Add users not on decks to end (maintain their relative order)
    usersNotOnDecks.forEach(djName => {
      this.state.djQueue.enqueue(djName);
      this.state.djSongCounts.set(djName, preservedSongCounts.get(djName) || 0);
    });
    
    console.log(`[REORDER] Final queue: ${this.state.djQueue.print()}`);
    
    this.commandHandler.updateQueuePublication();
    this.commandHandler.updateQueueSizeEnforcement();
  }

  handleRemDJ(data) {
    if (!this.state.queueEnabled) return;

    const user = data.user[0];
    this.state.cleanupSongTracking(user.name);
    
    if (this.state.djQueue.contains(user.name)) {
      setTimeout(() => {
        this.bot.roomInfo(false, (roomData) => {
          try {
            this.handleQueueReorderAfterLeave(user.name, roomData);
            
            // Check if we need to start fair turn system after someone leaves
            setTimeout(() => {
              this.checkForOpenSpotAndStartFairTurn();
            }, 1000);
          } catch (err) {
            console.error("Error reordering queue after DJ left:", err);
          }
        });
      }, 1000);
    } else {
      // Even if DJ not in queue, check for open spots
      setTimeout(() => {
        this.checkForOpenSpotAndStartFairTurn();
      }, 1000);
    }
  }

  handleQueueReorderAfterLeave(username, roomData) {
    const currentDjIds = roomData?.room?.metadata?.djs || [];
    const users = roomData?.users || [];
    const currentSong = roomData?.room?.metadata?.current_song;
    
    const djsOnDecks = currentDjIds.map(id => {
      const djUser = users.find(u => u.userid === id);
      return djUser ? djUser.name : null;
    }).filter(Boolean);
    
    if (djsOnDecks.length > 0) {
      this.reorderQueueForDeckPosition(djsOnDecks, currentDjIds, users, currentSong);
      this.commandHandler.speak(`Queue reordered after ${username} left. Current rotation: ${this.state.djQueue.print()}`);
    }
  }

  handleUserJoin(data) {
    const user = data.user[0];
    
    if (user.userid === process.env.DEEPCUT_BOT_USERID) {
      const statusMessage = this.redis.enabled ? 
        "🤖 I'm online! DJ queue system ready. Redis integration enabled." :
        "🤖 I'm online! DJ queue system ready. Running in standalone mode.";
      this.commandHandler.speak(statusMessage);
      return;
    }
    
    const isRefresh = this.checkIfRefresh(user.name);
    
    setTimeout(() => {
      this.sendWelcomeMessage(user, isRefresh);
    }, 2000);
  }

  checkIfRefresh(username) {
    if (this.state.recentlyLeftUsers.has(username)) {
      const leftTime = this.state.recentlyLeftUsers.get(username);
      const currentTime = Date.now();
      
      if (currentTime - leftTime <= Config.get().REFRESH_GRACE_PERIOD) {
        this.state.recentlyLeftUsers.delete(username);
        return true;
      } else {
        this.state.recentlyLeftUsers.delete(username);
      }
    }
    return false;
  }

  sendWelcomeMessage(user, isRefresh) {
    const welcomeText = isRefresh ? `Welcome back, @${user.name}! 🎵` : `Welcome to the room, @${user.name}! 🎵`;
    this.commandHandler.speak(welcomeText);
    
    if (isRefresh && this.state.queueEnabled && this.state.djQueue.contains(user.name)) {
      this.bot.pm("══════════════════\n" +
                   "Welcome back!\n" +
                   ".\n.\n.\n.\n.\n.\n.\n.\n.\n.\n" +
                   "You remain in the DJ queue.\n" + 
                   Utils.getTimestamp(), user.userid);
      return;
    }
    
    let message = this.buildWelcomeMessage(user.name, isRefresh);
    this.bot.pm(message, user.userid);
  }

  buildWelcomeMessage(username, isRefresh) {
    let message = "══════════════════\n";
    message += isRefresh ? "Welcome back! " : "Welcome! ";
    
    if (this.state.queueEnabled) {
      message += isRefresh ? 
        "As a reminder, this room uses a DJ queue system.\n" :
        "This room uses a DJ queue system.\n";
      
      message += ".\n.\n";
      
      if (this.state.djQueue.size() >= Config.get().QUEUE_FULL_SIZE) {
        message += "The queue is currently full. Type /a to join the queue and wait for an open spot.\n";
      } else {
        message += "Type /a to join the DJ queue or click \"Play Music\" to hop on the decks.\n";
      }
      
      message += ".\n";
      
      if (this.state.enforceOneSongPerDJ) {
        message += "Queue has 6+ people so DJs are limited to one song per turn with a 1-minute wait between turns.\n";
      }
      
      message += Utils.isAdmin(username) ? 
        "Use /q to see the current queue, /usercommands for user commands, and /admincommands for admin commands.\n" :
        "Use /q to see the current queue and /usercommands for all available commands.\n";
    } else {
      message += "Thanks for joining us!\n.\n.\n.\n";
      message += "Click \"Play Music\" to hop on the decks and start DJing.\n.\n.\n";
      message += Utils.isAdmin(username) ? 
        "Use /usercommands for user and /admincommands for admin commands.\n" :
        "Use /usercommands to see available commands.\n";
    }
    
    return message + Utils.getTimestamp();
  }

  handleUserLeave(data) {
    const user = data.user[0];
    
    if (user.userid === process.env.DEEPCUT_BOT_USERID) return;
    
    // Cleanup tracking
    this.state.djsToRemoveAfterSong.delete(user.name);
    this.state.cleanupSongTracking(user.name);
    
    this.commandHandler.speak(`@${user.name} has left the room.`);
    
    if (!this.state.queueEnabled) return;
    
    this.state.recentlyLeftUsers.set(user.name, Date.now());
    
    setTimeout(() => {
      this.handleDelayedRemovalFromQueue(user.name);
    }, Config.get().REFRESH_GRACE_PERIOD);
  }

  handleDelayedRemovalFromQueue(username) {
    this.mutex.acquire().then((release) => {
      try {
        if (this.state.recentlyLeftUsers.has(username)) {
          const leftTime = this.state.recentlyLeftUsers.get(username);
          const currentTime = Date.now();
          
          if (currentTime - leftTime >= Config.get().REFRESH_GRACE_PERIOD) {
            this.bot.roomInfo(false, (roomData) => {
              try {
                const users = roomData.users || [];
                const djs = roomData.room.metadata.djs || [];
                const audienceCount = users.length - djs.length;
                
                if (audienceCount >= 1 && this.state.djQueue.contains(username)) {
                  this.state.removeFromQueue(username);
                  this.state.removeFromRecentlyPlayed(username);
                  
                  setTimeout(() => {
                    this.commandHandler.speak(`@${username} was removed from the DJ queue after the 30-second grace period.`);
                  }, 1000);
                  
                  this.commandHandler.updateQueuePublication();
                  this.commandHandler.updateQueueSizeEnforcement();
                }
              } catch (innerErr) {
                console.error("Error checking room info for deregistered user:", innerErr);
              }
            });
            
            this.state.recentlyLeftUsers.delete(username);
          }
        }
      } finally {
        release();
      }
    });
  }
}

// Main Bot Class
class DJQueueBot {
  constructor() {
    this.setupProcessHandlers();
    
    this.bot = new Bot(
      process.env.DEEPCUT_BOT_AUTH,
      process.env.DEEPCUT_BOT_USERID,
      process.env.DEEPCUT_BOT_ROOMID,
    );
    
    this.redis = new RedisService();
    this.state = new StateManager();
    this.commandHandler = new CommandHandler(this.bot, this.state, this.redis);
    this.eventManager = new EventManager(this.bot, this.state, this.redis, this.commandHandler);
    
    // Start continuous deck monitoring
    setTimeout(() => {
      this.state.continuousDeckMonitoring(this.commandHandler);
    }, 5000); // Start monitoring after 5 seconds
  }

  setupProcessHandlers() {
    const signals = ['SIGTERM', 'SIGINT', 'SIGUSR1', 'SIGUSR2'];
    signals.forEach(signal => {
      process.on(signal, () => {
        console.log(`Received ${signal}, shutting down gracefully`);
        // Clean up fair turn timeouts before exit
        if (this.state) {
          this.state.clearNextDJTimeout();
        }
        process.exit(0);
      });
    });

    process.on('uncaughtException', (err) => {
      console.error('Uncaught Exception:', err);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  start() {
    console.log(`Bot starting... Redis integration: ${this.redis.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log("DJ Queue System with Skip Detection and Fair Turn System - Bot ready");
  }
}

// Initialize and start the bot
const djBot = new DJQueueBot();
djBot.start();