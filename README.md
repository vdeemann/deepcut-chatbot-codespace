# DJ Queue Bot

![Turntable.fm DJ Queue Bot in Action](./assets/turntable-room-screenshot.png)

*The DJ Queue Bot managing a live turntable.fm room with automatic queue enforcement and real-time notifications*

A sophisticated Turntable.fm bot for managing DJ queues with automatic queue management, fair play enforcement, and anti-exploitation protection.

## 🎵 Overview

Automatically manages DJ queues in Turntable.fm rooms, ensuring everyone gets a fair chance to play music through intelligent queue management and dynamic rule enforcement.

## ✨ Key Features

- **Automatic DJ Detection** - Auto-adds users to queue when joining decks
- **Smart Queue Reordering** - Maintains proper rotation order (main DJ first, left→right)
- **Dynamic Rules** - Switches between relaxed (< 6 users) and strict (6+ users) modes
- **Skip Detection** - Differentiates between skipped and naturally-ended songs
- **Anti-Exploitation** - Prevents cooldown bypassing and queue manipulation
- **30-Second Grace Period** - Protects against disconnections and refreshes
- **Real-Time Updates** - Event-driven Redis integration (optional)

## 📋 Queue Rules

### Relaxed Mode (< 6 users)
- Multiple songs per turn allowed
- Simple rotation announcements

### Strict Mode (6+ users)  
- **One song per turn** limit
- **1-minute cooldown** before rejoining decks
- Users stay in queue during cooldown
- Anti-exploitation protection active

### Special Protections
- **30-second grace period** when users leave room
- **Cooldown persistence** - can't be bypassed by leaving queue
- **Skip immunity** - no penalties for moderator-skipped songs
- **Fair turn enforcement** - removes DJs who leave queue mid-song

## 🎮 Commands

### User Commands
- `/q` - View current queue
- `/a` - Add yourself to queue  
- `/r` - Remove yourself from queue
- `/queuestatus` - Show system status
- `/usercommands` - Show all user commands

### Admin Commands
- `/enablequeue` - Enable queue system
- `/disablequeue` - Disable queue system
- `/syncqueue` - Sync with current DJs
- `/lockqueue` - Toggle queue lock
- `/clearqueue` - Clear all entries
- `/resetturns` - Reset all cooldowns
- `/@a [user]` - Add specific user
- `/@r [user]` - Remove specific user
- `/admincommands` - Show all admin commands

## 🚀 Quick Start

### Prerequisites
- Node.js (v14+)
- Turntable.fm bot account
- Redis server (optional)

### Environment Setup
```env
# Required
DEEPCUT_BOT_AUTH=your_bot_auth_token
DEEPCUT_BOT_USERID=your_bot_user_id  
DEEPCUT_BOT_ROOMID=target_room_id

# Admin Users (at least one required)
ADMIN_USERNAME_1=admin_username_1
ADMIN_USERNAME_2=admin_username_2  
ADMIN_USERNAME_3=admin_username_3

# Optional Redis
ENABLE_REDIS=true
UPSTASH_REDIS_AUTH=redis://your_redis_url
```

### Installation
```bash
npm install ttapi ioredis async-mutex

# Run standalone (no Redis)
node deepcutBot.js

# Run with Redis integration  
ENABLE_REDIS=true node deepcutBot.js
```

## 🔌 Redis Integration (Optional)

### Standalone Mode (Default)
- All features work locally
- No external dependencies
- Perfect for single-room usage

### Redis Mode  
- Real-time data publishing
- External integration support
- Queue and song data channels

### Data Channels
**Queue Status (`channel-1`):**
```json
{"DJs": "user1, user2, user3", "locked": false}
```

**Song Info (`channel-2`):**
```json
{
  "songName": "Track Title",
  "artist": "Artist Name",
  "djName": "DJ Username", 
  "audience": ["listener1", "listener2"],
  "djsOnDecks": ["dj1", "dj2"]
}
```

## 🔧 Configuration

```javascript
const QUEUE_SIZE_THRESHOLD = 6;      // Strict mode activation
const DJ_WAIT_TIME = 60000;          // 1-minute cooldown  
const REFRESH_GRACE_PERIOD = 30000;  // 30-second rejoin window
const MIN_SONG_DURATION = 30000;     // Skip detection threshold
```

## 🐛 Troubleshooting

**Commands not working:**
- Check exact command format
- Ensure queue system is enabled
- Verify admin permissions

**Queue issues:**
- Use `/syncqueue` to resync
- Check console logs for operations
- Verify proper rotation order

**Grace period problems:**
- Requires 1+ audience members to remove users
- Check logs for refresh detection
- Verify 30-second window timing

## 🔒 Features

- **Mutex concurrency control** - Prevents race conditions
- **Event-driven architecture** - Minimal network overhead  
- **Smart user lifecycle** - Handles disconnects gracefully
- **Persistent cooldowns** - Survives queue manipulation
- **Skip detection** - 30-second threshold analysis
- **Anti-exploitation** - Multiple protection layers

## 📄 License

GNU General Public License v3.0

---

**Made with 🎵 for the Turntable.fm community**