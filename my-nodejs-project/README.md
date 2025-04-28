# DJ Queue Bot

A Turntable.fm bot that manages a DJ queue system, providing fair and organized access to the DJ booth.

## Features

- **Live DJ Queue Management**: Organizes users who want to DJ
- **Admin Controls**: Special commands for room administrators
- **Redis Integration**: Publishes queue data to Redis for external applications
- **Thread Safety**: Ensures reliable operation using mutex locking

## Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/q` | View the current DJ queue |
| `/a` | Add yourself to the DJ queue |
| `/r` | Remove yourself from the DJ queue |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/enablequeue` | Enable the DJ queue system |
| `/disablequeue` | Disable the DJ queue system |
| `/lockqueue` | Toggle queue lock (when locked, only admins can modify the queue) |
| `/@a username` | Add a specific user to the DJ queue |
| `/@r username` | Remove a specific user from the DJ queue |

## System Behavior

### Queue States

- **Disabled**: Anyone can DJ (default state)
- **Enabled**: Only users in the queue can DJ
- **Locked**: Queue remains visible to all, but only admins can modify it

### Automatic Enforcement

- Users not in the queue who try to DJ are automatically removed
- After each song, the system checks if the current DJ is in the queue
- DJs removed from the queue are automatically removed from the booth

### Redis Publishing

- Queue state published every 10 seconds
- Contains DJ list and lock status
- Uses channel-1 for distribution

## Configuration

Set these environment variables:

```
DEEPCUT_BOT_AUTH=<bot-auth-token>
DEEPCUT_BOT_USERID=<bot-user-id>
DEEPCUT_BOT_ROOMID=<room-id>
UPSTASH_REDIS_AUTH=<redis-connection-string>
ADMIN_USERNAME_1=<first-admin-username>
ADMIN_USERNAME_2=<second-admin-username>
```

## Dependencies

- ttapi: Turntable.fm API client
- ioredis: Redis client
- async-mutex: Thread safety utilities
- Custom queue implementation
