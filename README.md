# DJ Queue Bot

A live DJ queue management system for chat-based music platforms.

## Overview

This bot provides a fair and organized way to manage DJ turns in a virtual room. It implements a queue system that allows users to join a line to become a DJ, ensures that only authorized DJs are on stage, and provides administrative controls for queue management.

## Features

- **DJ Queue Management**: Users can join and leave a queue to take turns being a DJ
- **Admin Controls**: Privileged users can enable/disable the queue, lock it, and manage queue members
- **Real-time Updates**: Queue status is published to Redis for integration with other systems
- **Auto-moderation**: Automatically removes DJs who aren't in the queue
- **Race-condition Protection**: Uses mutex locks to prevent queue corruption in concurrent operations

## Commands

### User Commands

- `/q` - View the current DJ queue
- `/a` - Add yourself to the DJ queue
- `/r` - Remove yourself from the DJ queue
- `/queuestatus` - Display the full status of the queue system

### Admin Commands

- `/enablequeue` - Turn on the queue system
- `/disablequeue` - Turn off the queue system
- `/lockqueue` - Toggle the queue lock (prevents non-admins from modifying the queue)
- `/@a username` - Add a specific user to the queue
- `/@r username` - Remove a specific user from the queue

## Technical Implementation

This bot is built using:
- **ttapi**: The core bot framework for interacting with the platform
- **ioredis**: Redis client for publishing queue updates
- **async-mutex**: Mutex implementation for preventing race conditions

The system is designed to handle concurrent operations safely while maintaining a consistent queue state.

## Environment Variables

The following environment variables need to be set:

- `DEEPCUT_BOT_AUTH` - Authentication token for the bot
- `DEEPCUT_BOT_USERID` - User ID for the bot
- `DEEPCUT_BOT_ROOMID` - Room ID where the bot will operate
- `UPSTASH_REDIS_AUTH` - Redis connection string
- `ADMIN_USERNAME_1` - First admin username
- `ADMIN_USERNAME_2` - Second admin username

## Queue Operation

When the queue is enabled:
1. Users must type `/a` to join the queue before they can become a DJ
2. Users who attempt to DJ without being in the queue are automatically removed
3. After a DJ finishes playing, they remain in the queue unless they use `/r` to remove themselves
4. Queue status is published to Redis every 10 seconds for integration with other systems

## Security and Permissions

- Only designated admins can enable/disable the queue system
- When the queue is locked, only admins can add or remove users
- All queue operations are protected by mutex locks to prevent race conditions

## Example Usage

1. Admin enables the queue: `/enablequeue`
2. Users join the queue: `/a`
3. Users can check who's waiting: `/q`
4. Users can leave the queue: `/r`
5. Admin can lock the queue during special events: `/lockqueue`
6. Anyone can check the system status: `/queuestatus`

## Notes

- The queue system is disabled by default on startup
- The bot will only monitor and enforce the queue when the system is enabled
- Redis publication can be used to display the queue status on external displays or websites
