# DJ Queue Bot

A Turntable.fm bot for managing a DJ queue system in music rooms.

## Overview

The DJ Queue Bot provides an automated queue management system for Turntable.fm rooms, allowing users to join a virtual line to take turns DJing. This helps manage crowded rooms where many users want to DJ, ensuring everyone gets a fair chance to play music.

## Features

- **Queue Management**: Users can join, leave, and view the current DJ queue
- **Admin Controls**: Room administrators can enable/disable the queue, lock/unlock it, add/remove specific users, and more
- **Dynamic Queue Rules**: Automatically enforces single-song limits when the queue gets crowded (6+ users)
- **Wait Time System**: Implements a 1-minute cooldown period before DJs can play again after their turn
- **Live Updates**: Publishes queue status to Redis for potential integration with external displays or websites
- **Song Information**: Publishes current playing song information to Redis

## Commands

### User Commands

- `/q` - View the current DJ queue
- `/a` - Add yourself to the DJ queue
- `/r` - Remove yourself from the DJ queue
- `/queuestatus` - Show complete system status
- `/usercommands` - Display all available user commands

### Admin Commands

- `/enablequeue` - Enable the DJ queue system
- `/disablequeue` - Disable the DJ queue system
- `/lockqueue` - Toggle queue lock status (locked/unlocked)
- `/clearqueue` - Clear all entries from the queue
- `/getcurrentdjbooth` - Add current DJs to the queue
- `/resetturns` - Reset all DJ wait times 
- `/@a [username]` - Add specific user to the queue
- `/@r [username]` - Remove specific user from the queue
- `/@commands` - Display all available admin commands

## Queue Rules

1. When fewer than 6 people are in the queue, DJs can play multiple songs per turn
2. When 6 or more people are in the queue, each DJ is limited to one song per turn
3. After playing their song in a crowded room, DJs must wait 1 minute before rejoining the decks
4. Users remain in the queue even during their wait period
5. Admins can override any of these restrictions

## Installation

1. Set up the following environment variables:
   - `DEEPCUT_BOT_AUTH` - Bot authentication token
   - `DEEPCUT_BOT_USERID` - Bot user ID
   - `DEEPCUT_BOT_ROOMID` - Room ID where the bot will operate
   - `UPSTASH_REDIS_AUTH` - Redis connection URL
   - `ADMIN_USERNAME_1` - First admin username
   - `ADMIN_USERNAME_2` - Second admin username

2. Install dependencies:
   ```
   npm install ttapi ioredis async-mutex
   ```

3. Ensure you have the `queue.js` file in the same directory (provides the Queue implementation)

4. Run the bot:
   ```
   node deepcutBot.js
   ```

## Redis Integration

The bot publishes to two Redis channels:

1. `channel-1`: Queue status updates (every 10 seconds)
   ```json
   { 
     "DJs": "username1, username2, username3",
     "locked": false
   }
   ```

2. `channel-2`: Current song information (on each new song)
   ```json
   {
     "songName": "Song Title",
     "artist": "Artist Name",
     "djName": "DJ Username",
     "startTime": 1683842567890,
     "roomName": "Room Name"
   }
   ```

## Key Features Explained

### Dynamic Queue Size Enforcement

When the queue reaches 6 or more users, the bot automatically enforces a "one song per turn" rule to ensure fairness. This prevents users from hogging the decks when many others are waiting.

### DJ Wait Time System

To prevent the same users from continuously cycling through the queue, the bot implements a 1-minute cooldown period. Users remain in the queue during their cooldown but cannot get on the decks until the cooldown expires.

### Mutex-Based Concurrency Control

The bot uses a mutex (mutual exclusion) mechanism to prevent race conditions when multiple users interact with the queue simultaneously:

- All queue operations acquire a mutex lock before execution
- Commands are processed sequentially to maintain queue integrity
- Redis publishing operations are protected by mutex locks
- Each function properly releases the mutex upon completion, even when errors occur
- This prevents data corruption when multiple chat commands are received in rapid succession

### Admin Override Controls

Room administrators have full control over the queue and can:
- Add or remove specific users
- Reset wait times
- Clear the entire queue
- Lock the queue to prevent changes

## Troubleshooting

- If commands aren't being recognized, check that your message format is exactly as specified
- For admin commands, ensure the admin usernames are correctly set in environment variables
- If the queue state seems inconsistent, try using `/getcurrentdjbooth` to synchronize with the current state
- If users aren't being properly removed from the decks, make sure the bot has moderator privileges in the room

## License

[Add your license information here]

## Support

[Add support contact information here]