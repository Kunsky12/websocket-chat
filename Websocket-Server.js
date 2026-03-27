require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------
// DATABASE
// ------------------------
const db = new sqlite3.Database('./chat.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        messageId TEXT PRIMARY KEY,
        playFabId TEXT,
        facebookId TEXT,
        flagId TEXT,
        rankSprite TEXT,
        timestamp TEXT,
        timestampTicks INTEGER,
        playerName TEXT,
        message TEXT,
        isDuelCall INTEGER DEFAULT 0
    )`);
});

// ------------------------
// SERVER
// ------------------------
const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY;
const server = app.listen(8080, () =>
    console.log(`Server running on port ${8080}`)
);
const wss = new WebSocketServer({ server });

// ------------------------
// STATE
// ------------------------
const activePlayers = new Map(); // playFabId -> ws
const publicQueues = new Map();  // gameMode -> [{ws, playerId, elo}]
const openDuels = new Map();     // messageId -> duel object
const playerLastAcceptTime = new Map(); // playFabId -> timestamp
const DUEL_TIMEOUT = 10_000; // 10 seconds
const playerLastDuelTime = new Map(); // playFabId -> timestamp


const DUEL_REGEX = /(^|[\s.,!?])(tos|1v1|duel|let'?s\s+duel|let'?s\s+fight|fight\s+me|challenge|1=)(?=$|[\s.,!?])/i;

// ------------------------
// HELPER FUNCTIONS
// ------------------------
function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(c => {
        if (c.readyState === 1) c.send(payload);
    });
}

function sendTo(playFabId, data) {
    const ws = activePlayers.get(playFabId);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function verifyJWT(JwtToken) {
    try {
        return jwt.verify(JwtToken, JWT_SECRET_KEY);
    } catch (err) {
        console.error('JWT verification failed:', err.message);
        return null;
    }
}

// ------------------------
// AUTO-EXPIRE DUELS
// ------------------------
setInterval(() => {
    const now = Date.now();
    for (const [messageId, duel] of openDuels.entries()) {
        if (duel.status === 'open' && now - duel.createdAt > DUEL_TIMEOUT) {
            duel.status = 'expired';
            openDuels.delete(messageId);
            broadcast({ type: 'duel.expired', messageId });

            // Remove rate-limit for player so they can duel again
            playerLastDuelTime.delete(duel.challengerId);
        }
    }
}, 10_000);

// ------------------------
// WEBSOCKET CONNECTION
// ------------------------
wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');
    ws.user = null;

    const sendHistory = () => {
        db.all('SELECT * FROM messages ORDER BY timestampTicks DESC LIMIT 10', (err, rows) => {
            if (!err) {
                const messages = rows.reverse().map(r => ({
                    ...r,
                    isDuelCall: !!r.isDuelCall,
                    duelStatus: r.isDuelCall ? (openDuels.get(r.messageId)?.status ?? 'expired') : null
                }));
                ws.send(JSON.stringify({ type: 'history', messages }));
            }
        });
    };

        ws.on('message', async (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }

            // ------------------------
            // AUTHENTICATION
            // ------------------------
            if (!ws.user) {
                if (msg.type !== 'auth') {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                    return;
                }

                const decoded = verifyJWT(msg.JwtToken);
                if (!decoded) {
                    ws.send(JSON.stringify({ type: 'auth.fail' }));
                    return ws.close();
                }

                ws.user = { playFabId: decoded.sub };
                activePlayers.set(decoded.sub, ws);

                ws.send(JSON.stringify({ type: 'auth.ok', playFabId: decoded.sub }));
                console.log(`✅ Authenticated ${decoded.sub}`);
                sendHistory();
                return;
            }

            const playerId = ws.user.playFabId;

            // ------------------------
            // MESSAGE HANDLERS
            // ------------------------
            switch (msg.type) {

           case 'chat': {

            const messageId = uuidv4();
            const isDuelCall = DUEL_REGEX.test(msg.message);
            const timestamp = new Date().toISOString();
            const timestampTicks = Date.now();

            const message = {
                messageId,
                playFabId: ws.user.playFabId,
                playerName: msg.playerName,
                message: msg.message,
                isDuelCall,
                duelStatus: isDuelCall ? 'open' : null,
                timestamp,
                timestampTicks,
                facebookId: msg.facebookId || null,
                flagId: msg.flagId || null,
                rankSprite: msg.rankSprite || null
            };

           // Save directly to DB
            db.run(
                `INSERT INTO messages (
                    messageId, playFabId, facebookId, flagId, rankSprite, timestamp, timestampTicks, playerName, message, isDuelCall
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    message.messageId,
                    message.playFabId,
                    message.facebookId,
                    message.flagId,
                    message.rankSprite,
                    message.timestamp,
                    message.timestampTicks,
                    message.playerName,
                    message.message,
                    message.isDuelCall ? 1 : 0
                ],
                (err) => {
                    if (err) console.error('Failed to save message:', err);
                    else console.log(`✅ Message saved to DB: ${messageId}`);
                }
            );

            if (isDuelCall) {
                const now = Date.now();
                const lastTime = playerLastDuelTime.get(playerId) || 0;

                if (now - lastTime < DUEL_TIMEOUT) {
                    ws.send(JSON.stringify({
                        type: 'duel.rateLimit',
                        message: `You already have an open duel. Wait ${Math.ceil((DUEL_TIMEOUT - (now - lastTime))/1000)}s before challenging again.`
                    }));
                    return; // prevent creating another duel
                }

                // Create duel
                openDuels.set(messageId, {
                    messageId,
                    challengerId: ws.user.playFabId,
                    challengerName: msg.playerName,
                    createdAt: now,
                    status: 'open'
                });

                // Update last duel timestamp
                playerLastDuelTime.set(playerId, now);

                console.log(`[DUEL] Open challenge from ${ws.user.playFabId} → msg ${messageId}`);
            }

            console.log(`Chat message from ${ws.user.playFabId} → msg ${message.message}`);

            broadcast({ type: 'chat', messages:[message] });
            break;
        }
           // ACCEPT DUEL
        case 'duel.accept': {
            const { messageId } = msg;
            const now = Date.now();

            // ----- RATE LIMIT -----
            const lastAccept = playerLastAcceptTime.get(playerId) || 0;
            if (now - lastAccept < DUEL_TIMEOUT) {
                return ws.send(JSON.stringify({
                    type: 'duel.rateLimit',
                    message: `You must wait ${Math.ceil((DUEL_TIMEOUT - (now - lastAccept))/1000)}s before accepting another duel.`
                }));
            }

            // update timestamp
            playerLastAcceptTime.set(playerId, now);

            // ----- EXISTING ACCEPT LOGIC -----
            const duel = openDuels.get(messageId);

            if (!duel || duel.status !== 'open') {
                console.log(`[DUEL] Duel not found or not open:`, duel);
                return ws.send(JSON.stringify({ type: 'duel.error', messageId, message: 'Duel unavailable' }));
            }

            if (duel.challengerId === ws.user.playFabId) {
                console.log(`[DUEL] Player tried to accept their own duel: ${ws.user.playFabId}`);
                return ws.send(JSON.stringify({ type: 'duel.error', messageId, message: "Can't accept your own duel" }));
            }

            duel.status = 'matched';
            duel.acceptorId = ws.user.playFabId;
            duel.acceptorName = msg.playerName;

            openDuels.delete(messageId);
            const matchId = uuidv4();

            // Request match from allocator and send to both players
            try {
                const resp = await axios.post(
                    'http://43.156.3.86:7777/api/v2/request-public-match',
                    { matchId, gameMode: 'VersusMen_Online', matchType: 'QuickPlay' }
                );

                const matchData = resp.data;

                sendTo(duel.challengerId, {
                    type: 'duel.matched',
                    messageId,
                    matchId,
                    player1Id: duel.challengerId,
                    player2Id: duel.acceptorId,
                    gameMode: matchData.gameMode,
                    serverIP: matchData.serverIP,
                    serverPort: matchData.serverPort,
                    tickRate: matchData.tickRate
                });

                ws.send(JSON.stringify({
                    type: 'duel.matched',
                    messageId,
                    matchId,
                    player1Id: duel.challengerId,
                    player2Id: duel.acceptorId,
                    gameMode: matchData.gameMode,
                    serverIP: matchData.serverIP,
                    serverPort: matchData.serverPort,
                    tickRate: matchData.tickRate
                }));

                broadcast({
                    type: 'duel.taken',
                    messageId,
                    player1Name: duel.challengerName,
                    player2Name: duel.acceptorName
                });

            } catch (err) {
                console.error('[DUEL MATCHMAKING] Allocator request failed:', err.message);
                sendTo(duel.challengerId, { type: 'duel.error', messageId, message: 'Failed to create duel match' });
                ws.send(JSON.stringify({ type: 'duel.error', messageId, message: 'Failed to create duel match' }));
            }

            break;
        }
            case 'JoinPublicQueue':
                const { gameMode, elo } = msg;
                if (!gameMode) return;

                if (!publicQueues.has(gameMode)) publicQueues.set(gameMode, []);
                const queue = publicQueues.get(gameMode);
                if (queue.some((p) => p.playerId === playerId)) return;

                queue.push({ ws, playerId, elo });
                console.log(`[MATCHMAKING] ${playerId} joined ${gameMode} | ELO: ${elo}`);

                if (queue.length >= 2) {
                    const [p1, p2] = queue.splice(0, 2);
                    const matchId = uuidv4();

                    try {
                        const resp = await axios.post(
                            'http://127.0.0.1:7777/api/v2/request-public-match',
                            { matchId, gameMode, matchType: 'QuickPlay' }
                        );
                        const matchData = resp.data;

                        const payload = {
                            type: 'MatchFound',
                            matchId: matchData.matchId,
                            gameMode,
                            player1Id: p1.playerId,
                            player2Id: p2.playerId,
                            serverIP: matchData.serverIP,
                            serverPort: matchData.serverPort,
                            tickRate: matchData.tickRate,
                        };

                        p1.ws.send(JSON.stringify(payload));
                        p2.ws.send(JSON.stringify(payload));

                        console.log(
                            `[MATCHMAKING] Allocator match created ${matchId} for ${gameMode} → ${matchData.serverIP}:${matchData.serverPort}`
                        );
                    } catch (err) {
                        console.error('[MATCHMAKING] Allocator request failed:', err.message);
                        p1.ws.send(JSON.stringify({ type: 'MatchError', message: 'Failed to allocate match' }));
                        p2.ws.send(JSON.stringify({ type: 'MatchError', message: 'Failed to allocate match' }));
                    }
                }
                break;


            case 'CancelMatchmaking': {
                for (const [mode, queue] of publicQueues.entries()) {
                    const index = queue.findIndex(p => p.playerId === playerId);
                    if (index !== -1) queue.splice(index, 1);
                }
                ws.send(JSON.stringify({ type: 'MatchCancelled', success: true }));
                break;
            }

           case 'lobby.create': {
            const { hostId, gameMode, matchType } = msg;
            if (!hostId || !gameMode) {
                ws.send(JSON.stringify({ type: 'lobby.error', message: 'Missing or invalid hostId/gameMode' }));
                return;
            }

            try {
                // Call your private match API instead of handling it manually
                const resp = await axios.post(
                    'http://127.0.0.1:7777/api/create-lobby', // your HTTP endpoint
                    { hostId, gameMode, matchType, matchPrivacy: 'Private' }
                );

                const data = resp.data;

                // Send the lobby/match info back to the client over WS
                ws.send(JSON.stringify({
                    type: 'lobby.created',
                    lobbyId: data.lobbyId,
                    matchId: data.matchId,
                    gameMode: data.gameMode,
                    serverIP: data.serverIP,
                    serverPort: data.serverPort,
                    tickRate: data.tickRate
                }));

                console.log(`[LOBBY] Lobby ${data.lobbyId} created via WS for ${hostId}`);
            } catch (err) {
                console.error('[LOBBY ERROR]', err?.message || err);
                ws.send(JSON.stringify({ type: 'lobby.error', message: 'Failed to create lobby' }));
            }
            break;
        }
                    // INVITES
           case 'invite.send': {
            const inviteData = msg; // already contains targetId, lobbyId, etc.
            const targetId = inviteData.targetId;
            const targetWs = activePlayers.get(targetId);

            if (targetWs) {
                targetWs.send(JSON.stringify({
                type: 'invite.received',
                from: playerId,
                lobbyData: inviteData   // <-- now matches client class
            }));
            }
            break;
        }

            default:
                console.warn('Unknown message type:', msg.type);
        }
    });

    ws.on('close', () => {
        if (ws.user) activePlayers.delete(ws.user.playFabId);
        for (const [mode, queue] of publicQueues.entries()) {
            const index = queue.findIndex(p => p.ws === ws);
            if (index !== -1) queue.splice(index, 1);
        }
        console.log(`Player ${ws.user?.playFabId} disconnected`);
    });

    ws.on('error', (err) => console.error('WebSocket error:', err));
});

app.post('/notify', (req, res) => {
    try {
        console.log('Received /notify POST:', req.body);

        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token' });

        const payload = jwt.verify(token, process.env.JWT_SECRET_KEY);

        if (payload.role !== 'service' || payload.sub !== 'notification-service') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { facebookId, referenceId, receiverId, senderName, transactionDate, amount, currency, message } = req.body;

        const ws = activePlayers.get(receiverId);
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'transaction_received',
                facebookId,
                senderName,
                transactionDate,
                referenceId,
                amount,
                currency,
                message
            }));
            console.log(`📡 Sent notification to ${receiverId}`);
        } else {
            console.log(`⚠️ Receiver ${receiverId} not connected or offline`);
        }

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        console.error('❌ Error in /notify', err);
        // Always respond
        res.status(400).json({ error: err.message });
    }
});

// ------------------------
// DAILY CHAT CLEANUP
// ------------------------
cron.schedule('0 0 * * *', () => {
    console.log('🧹 Running daily message cleanup...');
    db.run('DELETE FROM messages', (err) => {
        if (err) console.error('Error deleting messages:', err);
        else console.log('All messages deleted from chat.db');
    });
});