# DJ Queue Bot

A sophisticated Turntable.fm bot for managing DJ queues in music rooms with automatic queue management, fair play enforcement, and real-time updates.

## 🎵 Overview

The DJ Queue Bot provides an automated queue management system for Turntable.fm rooms, designed to handle crowded rooms where many users want to DJ. It ensures everyone gets a fair chance to play music through intelligent queue management, dynamic rule enforcement, and comprehensive admin controls.

## ✨ Key Features

### 🎯 Smart Queue Management
- **Automatic DJ Detection**: Automatically adds users to the queue when they join the decks
- **Dynamic Rule Enforcement**: Switches between relaxed and strict modes based on queue size
- **Fair Play System**: Prevents users from monopolizing the decks when others are waiting
- **Persistent Queue**: Users remain in queue even when stepping down from decks

### ⚡ Real-Time Features
- **Event-Driven Updates**: Publishes queue status only when changes occur (no constant polling)
- **Song Tracking**: Broadcasts current song information for external integrations
- **Instant Notifications**: Real-time feedback for all queue operations
- **Auto-Sync**: Synchronizes with current DJ booth state
- **Bot Status Monitoring**: Discord integration includes bot health checks

### 🛡️ Advanced Controls
- **Admin Override System**: Comprehensive admin controls for queue management
- **Queue Locking**: Prevents unauthorized queue modifications
- **Wait Time Management**: 1-minute cooldown periods between DJ turns in strict mode
- **Graceful User Handling**: Manages user disconnections and refreshes intelligently

## 📋 Queue Rules & Behavior

### Dynamic Queue Modes

**Relaxed Mode** (< 6 users in queue):
- DJs can play multiple songs per turn
- No automatic removal from decks
- Flexible queue management

**Strict Mode** (6+ users in queue):
- Each DJ limited to **one song per turn**
- **1-minute cooldown** before rejoining decks
- Automatic enforcement to ensure fairness
- Users remain in queue during cooldown
- Private message notifications when cooldown expires

### User Lifecycle Management

1. **Joining**: Users automatically added to queue when they get on decks
2. **Playing**: Song count tracked per DJ turn
3. **Cooldown**: 1-minute wait period in strict mode with private notifications
4. **Rejoining**: Can rejoin queue after cooldown expires
5. **Leaving**: 30-second grace period for page refreshes

### Welcome System

**Smart Welcome Messages**: All users receive personalized welcome messages regardless of queue status:

- **Queue Enabled**: Information about queue system and available commands
- **Queue Disabled**: Simple welcome with basic DJ instructions
- **Admin Users**: Additional information about admin commands
- **Returning Users**: Simplified welcome for users who refresh/rejoin

## 🎮 Commands Reference

### 👥 User Commands

| Command | Description |
|---------|-------------|
| `/q` | View the current DJ queue |
| `/a` | Add yourself to the DJ queue |
| `/r` | Remove yourself from the DJ queue (after current song) |
| `/queuestatus` | Show complete system status with wait times |
| `/usercommands` | Display all available user commands |

### 🔧 Admin Commands

| Command | Description |
|---------|-------------|
| `/enablequeue` | Enable the DJ queue system |
| `/disablequeue` | Disable the DJ queue system |
| `/lockqueue` | Toggle queue lock status |
| `/clearqueue` | Clear all entries from the queue |
| `/getcurrentdjbooth` | Sync queue with current DJs |
| `/resetturns` | Reset all DJ wait times |
| `/shutdown` | Gracefully shutdown the bot |
| `/@a [username]` | Add specific user to queue |
| `/@r [username]` | Remove specific user from queue |
| `/admincommands` | Display admin command reference |

## 🚀 Installation & Setup

### Prerequisites

- Node.js (v14 or higher)
- Redis server or Redis cloud service
- Turntable.fm bot account

### Environment Variables

Create a `.env` file with the following variables:

```env
# Bot Configuration
DEEPCUT_BOT_AUTH=your_bot_auth_token
DEEPCUT_BOT_USERID=your_bot_user_id
DEEPCUT_BOT_ROOMID=target_room_id

# Redis Configuration
UPSTASH_REDIS_AUTH=redis://your_redis_url

# Discord Configuration (optional)
DISCORD_TOKEN=your_discord_bot_token

# Admin Users (set at least one)
ADMIN_USERNAME_1=admin_username_1
ADMIN_USERNAME_2=admin_username_2
ADMIN_USERNAME_3=admin_username_3
```

### Installation Steps

1. **Clone and install dependencies:**
   ```bash
   npm install ttapi ioredis async-mutex discord.js
   ```

2. **Ensure required files:**
   - `queue.js` - Queue implementation class
   - `deepcutBot.js` - Main Turntable.fm bot file
   - `discordBot.js` - Discord integration bot (optional)
   - `.env` - Environment configuration

3. **Start the bots:**
   ```bash
   # Start the main Turntable.fm bot
   node deepcutBot.js
   
   # Start the Discord bot (in separate terminal)
   node discordBot.js
   ```

## 🔌 Redis Integration & Discord Bot

The bot provides real-time data through Redis channels for external integrations and includes a companion Discord bot for enhanced functionality.

### Redis Architecture

**Separate Connections**: Uses dedicated Redis connections for publishing and subscribing to prevent connection mode conflicts.

**Event-Driven Publishing**: Queue and song data is published only when actual changes occur, eliminating unnecessary network traffic.

### Redis Channels

#### Channel 1: Queue Status (`channel-1`)
Published when queue changes occur:

```json
{
  "DJs": "username1, username2, username3",
  "locked": false
}
```

**Special States:**
- `"DJs": "disabled"` - Queue system is disabled
- `"DJs": "Queue is empty"` - No users in queue

#### Channel 2: Song Information (`channel-2`)
Published on every new song and when requested:

```json
{
  "songName": "Song Title",
  "artist": "Artist Name", 
  "djName": "DJ Username",
  "startTime": 1683842567890,
  "roomName": "Room Name",
  "audience": ["listener1", "listener2"],
  "djsOnDecks": ["dj1", "dj2", "dj3"]
}
```

#### Channel 3: Bot Commands (`bot-commands`)
Used for communication between Discord and Turntable bots:

```json
{
  "command": "getCurrentRoomInfo",
  "timestamp": 1683842567890
}
```

### Discord Bot Integration

The companion Discord bot subscribes to Redis channels and provides enhanced community features with real-time room monitoring.

#### Discord Bot Features

**🎵 Live Music Status:**
- Real-time display of currently playing tracks
- Current DJ and all DJs on decks information
- Live queue status with accurate counts
- Room audience list with member counts
- Bot health monitoring with online/offline status

**📅 Event Management:**
- Monthly DJ event scheduling system
- Timezone-aware slot booking
- Automated conflict prevention
- Multi-month schedule viewing

#### Discord Commands

| Command | Description |
|---------|-------------|
| `!playing` | Show currently playing track, DJs, queue, and audience |
| `!djtimes` | Display next event DJ schedule |
| `!djtimes YYYY MM` | Show specific month's event schedule |
| `!signup <slot> <timezone>` | Sign up for an event DJ slot |
| `!events` | List next 6 upcoming events |

#### Enhanced !playing Command

The `!playing` command now provides comprehensive room information:

**When Turntable Bot is Online:**
- 🟢 Current song and artist
- Current DJ (who played the specific song)
- DJs on Decks (all current DJs with count)
- DJ Queue with accurate count (shows "DJ Queue (0): Queue is empty" when empty)
- Audience list with member count
- Turntable bot status

**When Turntable Bot is Offline:**
- 🔴 Clear offline status message
- Explanation of what the issue means
- Helpful suggestions for users

#### Event System

The Discord bot includes an event management system for regular DJ events:

**Features:**
- **Automatic Date Calculation**: Finds the first Friday of each month
- **Timezone Support**: Handles global DJs with timezone conversion
- **Conflict Prevention**: Prevents double-booking and unreasonable hours
- **Persistent Storage**: Schedules saved in Redis with unique keys
- **Smart Constraints**: 
  - No scheduling during 11pm-7am in DJ's local time
  - One slot per DJ per event
  - Prevents conflicts with existing bookings

**Supported Timezones:**
- `America/New_York` (EDT/EST)
- `America/Chicago` (CDT/CST)
- `America/Denver` (MDT/MST)
- `America/Los_Angeles` (PDT/PST)
- `Europe/London` (BST/GMT)
- `Europe/Paris` (CEST/CET)
- `Asia/Tokyo` (JST)
- `Australia/Sydney` (AEST/AEDT)

**Available Time Slots:**
- 9:00 AM UTC
- 10:00 AM UTC
- 11:00 AM UTC
- 1:00 PM UTC
- 2:00 PM UTC
- 3:00 PM UTC
- 4:00 PM UTC

#### Discord Bot Setup

**Additional Environment Variables:**
```env
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token
```

**Required Permissions:**
- Send Messages
- Embed Links
- Read Message History
- Use Slash Commands (optional)

**Installation:**
```bash
npm install discord.js
```

## 🏗️ Architecture & Design

### Concurrency Control
- **Mutex-based locking** prevents race conditions
- **Sequential command processing** maintains data integrity
- **Atomic queue operations** ensure consistency
- **Error-safe releases** prevent deadlocks

### Event-Driven Architecture
- **Real-time event handling** for user actions
- **Event-driven publishing** reduces network overhead
- **Automatic state synchronization** with room events
- **Graceful error recovery** and logging
- **Clean shutdown procedures**

### Redis Connection Management
- **Separate Publisher/Subscriber connections** prevent mode conflicts
- **Automatic reconnection** handling
- **Error isolation** between publish and subscribe operations

### Configuration Constants

```javascript
const QUEUE_SIZE_THRESHOLD = 6;      // When strict mode activates
const QUEUE_FULL_SIZE = 5;           // "Full queue" announcement
const DJ_WAIT_TIME = 60000;          // 1-minute cooldown (ms)
const REFRESH_GRACE_PERIOD = 30000;  // 30-second rejoin window
```

## 🎛️ Advanced Features

### Smart User Management
- **Refresh Detection**: Distinguishes between disconnects and page refreshes
- **Grace Period Handling**: 30-second window for users to rejoin
- **Automatic Queue Maintenance**: Removes users who leave permanently
- **Intelligent Welcome System**: Contextual messages based on queue status

### Dynamic Enforcement
- **Automatic Mode Switching**: Seamlessly transitions between relaxed/strict modes
- **Real-time Announcements**: Keeps users informed of rule changes
- **Private Notifications**: Personal messages for cooldown periods

### Admin Tools
- **Comprehensive Override**: Admins can bypass all restrictions
- **Bulk Operations**: Clear queues, reset timers, force sync
- **System Monitoring**: Real-time status reporting
- **Dedicated Admin Commands**: Separate command set for administrators

### Communication Systems
- **Private Messaging**: Formatted PMs with consistent styling
- **Public Announcements**: Clear room-wide notifications
- **Status Updates**: Real-time feedback for all operations

## 🐛 Troubleshooting

### Common Issues

**Commands not working:**
- Verify exact command format (case-sensitive)
- Check bot has speaking privileges in room
- Ensure queue system is enabled for user commands

**Admin commands failing:**
- Confirm username matches environment variables exactly
- Check bot has moderator privileges for user removal
- Verify environment variables are loaded correctly

**Queue state inconsistencies:**
- Use `/getcurrentdjbooth` to resync with room state
- Check Redis connection for live updates
- Restart bot if persistent issues occur

**Discord bot showing "Unknown" data:**
- Verify Redis connections between both bots
- Check if turntable bot is online using `!playing`
- Ensure both bots use the same Redis instance

**Redis connection errors:**
- Verify Redis URL format and credentials
- Check network connectivity to Redis server
- Ensure both publisher and subscriber connections are working

### Debug Mode
Enable verbose logging by setting:
```bash
DEBUG=true node deepcutBot.js
```

## 📊 Monitoring & Metrics

The bot provides comprehensive logging for:
- Queue operations and state changes
- User lifecycle events (join/leave/refresh)
- Command execution and errors
- Redis publish/subscribe activity
- Admin actions and overrides
- Discord bot integration status

## 🔒 Security Considerations

- **Admin Authentication**: Username-based admin verification
- **Command Validation**: Input sanitization and validation
- **Rate Limiting**: Built-in cooldowns prevent spam
- **Graceful Shutdown**: Clean termination on system signals
- **Connection Security**: Separate Redis connections prevent interference

## 🤝 Contributing

When contributing to this project:
1. Maintain mutex-based concurrency control
2. Add comprehensive error handling
3. Update documentation for new features
4. Test edge cases thoroughly
5. Follow existing code patterns
6. Ensure Redis connection management is preserved

## 📄 License

This project is licensed under the GNU General Public License v3.0 - see the LICENSE file for details.

## 📞 Support

For issues, questions, or feature requests:
- Create an issue in the project repository
- Check the troubleshooting section above
- Review the Redis integration logs for connectivity issues
- Use `/queuestatus` command for system diagnostics

---

**Made with 🎵 for the Turntable.fm community**