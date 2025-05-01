# DeepCut DJ Queue Bot

A Node.js bot for managing DJ queues in TurntableAPI-compatible music rooms. This bot maintains an organized queue system for live DJs, enforces queue order, and provides real-time queue updates through Redis.

## Features

- **DJ Queue Management**: Maintains an ordered list of users waiting to DJ
- **Admin Controls**: Special commands for moderators to manage the queue
- **Redis Integration**: Real-time queue publication to external services
- **Song Tracking**: Publishes current song information to Redis
- **Queue Enforcement**: Automatically removes DJs who aren't in the queue

## Setup

### Prerequisites

- Node.js
- npm or yarn
- Redis instance (Upstash recommended)
- TurntableAPI bot account

### Environment Variables

Set up the following environment variables:

```
DEEPCUT_BOT_AUTH=your_bot_auth_token
DEEPCUT_BOT_USERID=your_bot_user_id
DEEPCUT_BOT_ROOMID=your_room_id
UPSTASH_REDIS_AUTH=your_redis_connection_string
ADMIN_USERNAME_1=admin_username1
ADMIN_USERNAME_2=admin_username2
```

### Installation

1. Clone the repository
2. Install dependencies: `npm install`
3. Run the bot: `node deepcutBot.js`

## Usage

### User Commands

| Command | Description |
|---------|-------------|
| `/q` | View the current DJ queue |
| `/a` | Add yourself to the DJ queue |
| `/r` | Remove yourself from the DJ queue |
| `/queuestatus` | View full queue system status |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/enablequeue` | Enable the DJ queue system |
| `/disablequeue` | Disable the DJ queue system |
| `/lockqueue` | Toggle lock state of the queue |
| `/clearqueue` | Clear all users from the queue |
| `/@a username` | Add a specific user to the queue |
| `/@r username` | Remove a specific user from the queue |

## Redis Channels

The bot publishes to two Redis channels:

- **channel-1**: Queue state information (updated every 10 seconds when enabled)
  ```json
  {
    "DJs": "user1, user2, user3",
    "locked": false
  }
  ```

- **channel-2**: Current song information (published on each new song)
  ```json
  {
    "songName": "Example Song",
    "artist": "Example Artist",
    "djName": "DJ Username",
    "startTime": 1619123456789,
    "roomName": "Room Name"
  }
  ```

## Queue Behavior

- When the queue is enabled, users must be in the queue to DJ
- Users attempting to DJ without being in the queue will be removed
- The bot sends a private message explaining how to join the queue
- When the queue is locked, only admins can modify it
- After each song, the bot verifies the current DJ is in the queue

## Troubleshooting

- If commands aren't registering, ensure they're typed exactly as shown
- Commands can be typed at the end of a message (e.g., "Hello everyone /q")
- Redis connection issues will appear in the console logs
- Mutex locks prevent race conditions when multiple commands run simultaneously

## Dependencies

- ttapi: TurntableAPI client library
- ioredis: Redis client
- async-mutex: Mutex for state management