# DJ Queue Bot

A Turntable.fm bot that manages a live DJ queue system for music rooms, allowing fair and organized DJ rotations.

## Overview

The DJ Queue Bot provides a structured system for managing DJs in a Turntable.fm room. It maintains a queue of users waiting to DJ, publishes queue updates via Redis, and enforces queue-based DJ booth access when enabled.

## Features

- **Queue Management**: Users can add themselves to the queue, remove themselves, and view the current queue
- **Admin Controls**: Admins can enable/disable the queue, lock/unlock it, add/remove specific users, and clear the queue
- **DJ Booth Enforcement**: When enabled, only users in the queue can DJ
- **Redis Publishing**: Live queue updates are published to Redis for integration with external services
- **Current DJ Tracking**: Tracks current song information and publishes it to Redis

## Commands

### User Commands

- `/q` - View the current DJ queue
- `/a` - Add yourself to the DJ queue
- `/r` - Remove yourself from the DJ queue
- `/queuestatus` - Display the current status of the queue system

### Admin Commands

- `/enablequeue` - Enable the queue system
- `/disablequeue` - Disable the queue system
- `/lockqueue` - Toggle lock status of the queue (locked = admin-only modifications)
- `/clearqueue` - Clear all users from the queue
- `/getcurrentdjbooth` - Sync the queue with current DJs in the booth
- `/@a username` - Add a specific user to the queue (admin only)
- `/@r username` - Remove a specific user from the queue (admin only)

## Setup

1. Install dependencies:
   ```
   npm install ttapi ioredis async-mutex
   ```

2. Set the following environment variables:
   - `DEEPCUT_BOT_AUTH` - Your Turntable.fm bot authentication token
   - `DEEPCUT_BOT_USERID` - Your Turntable.fm bot user ID
   - `DEEPCUT_BOT_ROOMID` - The Turntable.fm room ID to operate in
   - `UPSTASH_REDIS_AUTH` - Redis connection string
   - `ADMIN_USERNAME_1` - Username of the first admin
   - `ADMIN_USERNAME_2` - Username of the second admin

3. You'll need to create a `queue.js` file for the Queue class implementation

## Redis Channels

The bot publishes to two Redis channels:

- `channel-1`: DJ queue updates in the format: `{ DJs: [username list], locked: boolean }`
- `channel-2`: Current song information in the format: `{ songName, artist, djName, startTime, roomName }`

## Error Handling

The bot includes comprehensive error handling with the following features:
- Mutex locks to prevent race conditions 
- Error cooldowns to prevent message spam
- Detailed logging for troubleshooting
- Promises for asynchronous operations

## Implementation Details

- Uses a mutex to prevent race conditions in queue operations
- Implemented with Promise-based async/await patterns
- Maintains state for queue enabling/locking
- Periodic publishing to Redis for external system integration

## Security

Only authenticated admins can perform privileged actions like:
- Enabling/disabling the queue system
- Clearing the queue
- Adding/removing specific users

## Notes

- The queue can be disabled temporarily for open DJ sessions
- When the queue is locked, only admins can modify it
- Users not in the queue will be automatically removed from the DJ booth