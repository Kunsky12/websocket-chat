# Websocket-Service/Chat

A real-time WebSocket-based chat and matchmaking server for online multiplayer games. Built with Node.js, it handles in-game chat, player-initiated duels, public matchmaking queues, private lobbies, and in-game transaction notifications.

---

## Features

- **Real-time chat** — Persistent chat history (last 10 messages) with SQLite storage and daily auto-cleanup
- **Duel system** — Players can challenge each other via chat keywords (`1v1`, `duel`, `tos`, etc.), with automatic expiry, rate limiting, and live status broadcasting
- **Public matchmaking** — ELO-aware queue system that pairs two players and allocates a game server via an external allocator API
- **Private lobbies** — Host-initiated private matches with invite forwarding to targeted players
- **Transaction notifications** — Secure HTTP endpoint for an internal notification service to push payment events to connected players
- **JWT authentication** — Every WebSocket connection must authenticate before sending or receiving messages

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Web framework | Express |
| WebSocket | ws |
| Database | SQLite3 |
| Auth | JSON Web Tokens (jsonwebtoken) |
| HTTP client | Axios |
| Scheduling | node-cron |
| IDs | uuid |

---

## Getting Started

### Prerequisites

- Node.js v18+
- npm

### Installation

```bash
git clone https://github.com/your-org/ChatSystem.git
cd ChatSystem
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
JWT_SECRET_KEY=your_jwt_secret_here
```

### Running the Server

```bash
node index.js
```

The server starts on **port 8080**.

---

## WebSocket API

All communication after connection must be over WebSocket (`ws://host:8080`).

### Authentication

Every client must send an `auth` message immediately after connecting. All other messages are rejected until authentication succeeds.

```json
{ "type": "auth", "JwtToken": "<signed-jwt>" }
```

**Responses:**
- `auth.ok` — authenticated successfully
- `auth.fail` — invalid token, connection closed

---

### Message Types

#### `chat`
Send a chat message. Messages containing duel keywords (`1v1`, `duel`, `tos`, `challenge`, etc.) automatically create an open duel.

```json
{
  "type": "chat",
  "message": "anyone want to 1v1?",
  "playerName": "Hero123",
  "facebookId": "...",
  "flagId": "...",
  "rankSprite": "..."
}
```

#### `duel.accept`
Accept an open duel by `messageId`. Triggers server allocation and sends match details to both players.

```json
{ "type": "duel.accept", "messageId": "<uuid>", "playerName": "Challenger99" }
```

#### `JoinPublicQueue`
Join the matchmaking queue for a given game mode.

```json
{ "type": "JoinPublicQueue", "gameMode": "VersusMen_Online", "elo": 1200 }
```

#### `CancelMatchmaking`
Leave the matchmaking queue.

```json
{ "type": "CancelMatchmaking" }
```

#### `lobby.create`
Create a private lobby. Contacts the allocator and returns server connection details.

```json
{ "type": "lobby.create", "hostId": "player123", "gameMode": "VersusMen_Online", "matchType": "Private" }
```

#### `invite.send`
Send a lobby invite to another connected player.

```json
{ "type": "invite.send", "targetId": "player456", "lobbyId": "...", "serverIP": "...", "serverPort": 7777 }
```

---

## HTTP API

### `POST /notify`

Used internally by the notification service to push transaction events to connected players.

**Headers:**
```
Authorization: Bearer <service-jwt>
```

**Body:**
```json
{
  "receiverId": "playFabId",
  "senderName": "Alice",
  "amount": 100,
  "currency": "USD",
  "message": "Good game!",
  "facebookId": "...",
  "referenceId": "...",
  "transactionDate": "2025-01-01T00:00:00Z"
}
```

> The service JWT must have `role: "service"` and `sub: "notification-service"`.

---

## Database

SQLite database stored at `./chat.db`.

**`messages` table:**

| Column | Type | Description |
|---|---|---|
| messageId | TEXT | Primary key (UUID) |
| playFabId | TEXT | Sender's PlayFab ID |
| facebookId | TEXT | Sender's Facebook ID |
| flagId | TEXT | Country/flag identifier |
| rankSprite | TEXT | Player rank icon |
| timestamp | TEXT | ISO 8601 timestamp |
| timestampTicks | INTEGER | Unix ms timestamp |
| playerName | TEXT | Display name |
| message | TEXT | Chat message content |
| isDuelCall | INTEGER | 1 if message triggered a duel |

> **Note:** All messages are deleted daily at midnight via a cron job.

---

## Duel Lifecycle

```
Player sends duel keyword in chat
        │
        ▼
   Duel created (status: open)
        │
   10s timeout ──► duel.expired (broadcast)
        │
   Another player sends duel.accept
        │
        ▼
   Allocator called → match server assigned
        │
        ▼
   duel.matched sent to both players
   duel.taken broadcast to all
```

**Rate limits:**
- A player can only have one open duel at a time (10s cooldown)
- A player must wait 10s between accepting duels

---

## License

ISC
