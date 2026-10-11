const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { createAdapter } = require("@socket.io/redis-adapter");

const app = express();

app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: [
            "http://localhost:5173",
            "http://localhost:5174"
        ],
        methods: ["GET", "POST"]
    }
});

let redisClients = [];
let redisPubClient;
let presenceHeartbeat;
const onlineUsers = new Map();
const MAX_VISIBLE_USERS = 100;
const PRESENCE_TTL_MS = 180_000;
const USER_HASH = "chat:online-users";
const USER_EXPIRY = "chat:online-users:expiry";

async function removeExpiredRedisUsers() {
    const expiredIds = await redisPubClient.eval(
        `local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
         for _, id in ipairs(ids) do
           redis.call('ZREM', KEYS[1], id)
           redis.call('HDEL', KEYS[2], id)
         end
         return ids`,
        2,
        USER_EXPIRY,
        USER_HASH,
        Date.now()
    );
    for (const id of expiredIds) io.emit("user_left", { id });
    if (expiredIds.length) io.emit("online_count", await redisPubClient.zcard(USER_EXPIRY));
    return expiredIds.length;
}

async function presenceSnapshot() {
    if (!redisPubClient) {
        return { count: onlineUsers.size, users: Array.from(onlineUsers, ([id, name]) => ({ id, name })).slice(0, MAX_VISIBLE_USERS) };
    }

    await removeExpiredRedisUsers();
    const [count, ids] = await Promise.all([
        redisPubClient.zcard(USER_EXPIRY),
        redisPubClient.zrange(USER_EXPIRY, 0, MAX_VISIBLE_USERS - 1)
    ]);
    const names = ids.length ? await redisPubClient.hmget(USER_HASH, ...ids) : [];
    return {
        count,
        users: ids.flatMap((id, index) => names[index] ? [{ id, name: names[index] }] : [])
    };
}

async function registerPresence(socket, name) {
    const expiresAt = Date.now() + PRESENCE_TTL_MS;
    if (redisPubClient) {
        await redisPubClient.multi()
            .hset(USER_HASH, socket.id, name)
            .zadd(USER_EXPIRY, expiresAt, socket.id)
            .exec();
    } else {
        onlineUsers.set(socket.id, name);
    }
    socket.data.username = name;
}

async function removePresence(socketId) {
    if (redisPubClient) {
        await redisPubClient.multi().hdel(USER_HASH, socketId).zrem(USER_EXPIRY, socketId).exec();
        return redisPubClient.zcard(USER_EXPIRY);
    }
    onlineUsers.delete(socketId);
    return onlineUsers.size;
}

const clientBuild = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientBuild));

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("set_username", async (name) => {
        const cleanName = typeof name === "string" ? name.trim().slice(0, 32) : "";
        if (!cleanName) return;
        const previousName = socket.data.username;
        try {
            await registerPresence(socket, cleanName);
            const snapshot = await presenceSnapshot();
            socket.emit("online_users", snapshot);
            if (previousName !== cleanName) {
                const event = previousName ? "user_renamed" : "user_joined";
                io.emit(event, { user: { id: socket.id, name: cleanName }, count: snapshot.count });
                io.emit("receive_message", {
                    type: "notice",
                    text: previousName ? `${previousName} is now ${cleanName}.` : `${cleanName} joined.`,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error("Unable to register online user:", error.message);
        }
    });

    socket.on("send_message", async (data, acknowledge) => {
        const reply = typeof acknowledge === "function" ? acknowledge : () => {};
        const message = typeof data?.message === "string" ? data.message.trim().slice(0, 2000) : "";
        const username = socket.data.username;
        if (!username || !message) {
            reply({ error: "Choose a name and enter a message first." });
            return;
        }
        const now = Date.now();
        if (!socket.data.messageWindow || now - socket.data.messageWindow.startedAt >= 5000) {
            socket.data.messageWindow = { startedAt: now, count: 0 };
        }
        if (socket.data.messageWindow.count >= 10) {
            reply({ error: "You’re sending messages too quickly. Please wait a moment." });
            return;
        }
        socket.data.messageWindow.count += 1;
        const recipientId = typeof data?.recipientId === "string" ? data.recipientId : "";
        if (recipientId && !/^[\w-]{1,64}$/.test(recipientId)) {
            reply({ error: "That contact is not available." });
            return;
        }
        const payload = {
            username,
            message,
            timestamp: new Date().toISOString(),
            senderId: socket.id
        };

        if (!recipientId) {
            io.emit("receive_message", { ...payload, conversationId: "general" });
            reply({ ok: true });
            return;
        }

        if (recipientId === socket.id) {
            reply({ error: "Use Saved messages to chat with yourself." });
            return;
        }

        try {
            const recipients = await io.in(recipientId).fetchSockets();
            if (!recipients.length || !recipients[0].data.username) {
                reply({ error: "This person is offline. Messages can only be sent to online users." });
                return;
            }
            const conversationId = `dm:${[socket.id, recipientId].sort().join(":")}`;
            io.to(socket.id).to(recipientId).emit("receive_message", {
                ...payload,
                recipientId,
                conversationId
            });
            reply({ ok: true });
        } catch (error) {
            console.error("Unable to route direct message:", error.message);
            reply({ error: "Message could not be delivered. Please try again." });
        }
    });

    socket.on("disconnect", async () => {
        console.log("User disconnected:", socket.id);
        const username = socket.data.username;
        try {
            const count = await removePresence(socket.id);
            if (username) {
                io.emit("user_left", { id: socket.id, count });
                io.emit("receive_message", {
                    type: "notice",
                    text: `${username} left.`,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error("Unable to remove online user:", error.message);
        }
    });
});

app.get("/health", (req, res) => {
    if (redisPubClient && redisPubClient.status !== "ready") {
        return res.status(503).send("Redis unavailable");
    }
    res.status(200).send("OK");
});

async function startServer() {
    if (process.env.REDIS_URL) {
        const pubClient = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
        const subClient = pubClient.duplicate({ lazyConnect: true, maxRetriesPerRequest: null });
        pubClient.on("error", (error) => console.error("Redis publisher error:", error.message));
        subClient.on("error", (error) => console.error("Redis subscriber error:", error.message));
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        redisClients = [pubClient, subClient];
        redisPubClient = pubClient;
        presenceHeartbeat = setInterval(async () => {
            try {
                const now = Date.now();
                const pipeline = redisPubClient.multi();
                for (const socket of io.sockets.sockets.values()) {
                    if (socket.data.username) {
                        pipeline.hset(USER_HASH, socket.id, socket.data.username);
                        pipeline.zadd(USER_EXPIRY, now + PRESENCE_TTL_MS, socket.id);
                    }
                }
                await pipeline.exec();
                await removeExpiredRedisUsers();
            } catch (error) {
                console.error("Presence heartbeat failed:", error.message);
            }
        }, 30_000);
        console.log("Socket.IO Redis adapter enabled");
    }

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch((error) => {
    console.error("Server startup failed:", error);
    process.exit(1);
});

async function shutdown() {
    clearInterval(presenceHeartbeat);
    const registeredSockets = Array.from(io.sockets.sockets.values()).filter((socket) => socket.data.username);
    if (redisPubClient) {
        const pipeline = redisPubClient.multi();
        for (const socket of registeredSockets) {
            pipeline.hdel(USER_HASH, socket.id);
            pipeline.zrem(USER_EXPIRY, socket.id);
        }
        await pipeline.exec();
    } else {
        for (const socket of registeredSockets) onlineUsers.delete(socket.id);
    }
    const remainingCount = redisPubClient ? await redisPubClient.zcard(USER_EXPIRY) : onlineUsers.size;
    for (const socket of registeredSockets) {
        socket.data.username = undefined;
        io.emit("user_left", { id: socket.id, count: remainingCount });
    }
    await new Promise((resolve) => io.close(resolve));
    await Promise.all(redisClients.map((client) => client.quit().catch(() => client.disconnect())));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
