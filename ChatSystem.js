require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { WebSocketServer } = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// SQLite DB
const db = new sqlite3.Database('./chat.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
    playFabId TEXT,
    facebookId TEXT,
    flagId TEXT,
    rankSprite TEXT,
    timestamp TEXT,
    timestampTicks INTEGER,
    playerName TEXT,
    message TEXT
    )`);
});

// Start HTTP server
const PORT = 8080;
const server = app.listen(PORT, () =>
    console.log(`Websocket server running on http://43.156.3.86:${PORT}`)
);

// WebSocket server
const wss = new WebSocketServer({ server });

// Broadcast helper
function broadcast(data, exclude) {
    wss.clients.forEach(client => {
        if (client !== exclude && client.readyState === 1) {
            client.send(JSON.stringify(data));
        }
    });
}

const activePlayers = new Map(); // key: playFabId, value: ws

wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');

    let playFabId = null; // define per connection
    let authed = false;

    // Only send chat history after authentication
    const sendHistory = () => {
        db.all(
            'SELECT * FROM messages ORDER BY timestampTicks DESC LIMIT 10',
            (err, rows) => {
                if (!err) ws.send(JSON.stringify({ type: 'history', messages: rows.reverse() }));
            }
        );
    };

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        // --- Authenticate first ---
        if (!authed) {
            if (msg.type !== 'auth') {
                ws.send(JSON.stringify({ type: 'error', data: { code: 'not_authed', message: 'Please authenticate first' } }));
                return;
            }

            if (!msg.playFabId || !msg.sessionTicket) {
                ws.send(JSON.stringify({ type: 'auth.fail', data: { reason: 'Missing playFabId or sessionTicket' } }));
                return ws.close();
            }

            playFabId = msg.playFabId;
            const context = msg.context || "mainmenu"; // default to mainmenu
            authed = true;
            activePlayers.set(playFabId, ws);

            ws.send(JSON.stringify({ type: 'auth.ok', playFabId, context }));
            console.log(`Player ${playFabId} authenticated (context=${context})`);

            // ✅ Only send history for mainmenu
            if (context === "mainmenu") {
                sendHistory();
            }
            return;
        }

        // --- Handle chat ---
        if (msg.type === 'chat') {
            const stmt = db.prepare(`
        INSERT INTO messages (
            playFabId,
            facebookId,
            flagId,
            rankSprite,
            timestamp,
            timestampTicks,
            playerName,
            message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
        msg.playFabId,
        msg.facebookId,
        msg.flagId,
        msg.rankSprite,
        msg.timestamp,
        msg.timestampTicks,
        msg.playerName,
        msg.message,
        function (err) {
            if (err) {
            console.error('DB insert error:', err);
            return;
            }

            const chatMessage = {
            type: 'chat',
            messages: [{
                playFabId: msg.playFabId,
                facebookId: msg.facebookId,
                flagId: msg.flagId,
                rankSprite: msg.rankSprite,
                timestamp: msg.timestamp,
                timestampTicks: msg.timestampTicks,
                playerName: msg.playerName,
                message: msg.message
            }]
            };

            broadcast(chatMessage);
        }
        );

        stmt.finalize();
        }

        // --- Handle invites ---a
        if (msg.type === 'invite.send') {
            const inviteData = msg.data || msg; // support sending plain LobbyInviteData
            const targetId = inviteData.targetId;
            const targetWs = activePlayers.get(targetId);
            if (targetWs) {
                targetWs.send(JSON.stringify({ type: 'invite.received', data: inviteData }));
                console.log(`Invite sent to ${targetId}:`, inviteData);
            }
        }
    });

    ws.on('close', () => {
        if (playFabId) {
            activePlayers.delete(playFabId);
            console.log(`Player ${playFabId} disconnected`);
        }
    });

    ws.on('error', (err) => console.error('WebSocket error:', err));
});


// CRON JOB: Clear chat daily at midnight
cron.schedule('0 0 * * *', () => {
    console.log('🧹 Running daily message cleanup...');
    db.run('DELETE FROM messages', (err) => {
        if (err) console.error('Error deleting messages:', err);
        else console.log('All messages deleted from chat.db');
    });
});
