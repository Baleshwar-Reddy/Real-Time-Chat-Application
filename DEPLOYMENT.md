# Deployment and scaling

## Render

Create a Render Blueprint from this repository and select `render.yaml`. The Blueprint builds the Vite client and runs it from the existing Express/Socket.IO server. `/health` is the Render health check. The service binds to `0.0.0.0` and uses Render's `PORT` value.

The chat needs the **Node Web Service** described by the Blueprint. A Render Static Site can serve the client but cannot host Socket.IO: the deployed app's `/health` endpoint should return `OK`, and `/socket.io/` must be handled by the same web service. If either endpoint returns Render's plain `Not Found`, deploy the Blueprint as a Web Service and use that service's URL. The client starts with Socket.IO polling and upgrades to WebSocket when available, so it also works behind proxies that block WebSocket upgrades.

If the frontend and backend are deployed as separate Render services, the client uses `VITE_SOCKET_URL` (defaulting in production to `https://real-time-chat-application-0one.onrender.com`) to reach the backend. The backend allows the current frontend origin; for a different frontend URL, set `CLIENT_ORIGINS` on the backend to a comma-separated list of exact frontend origins. The backend root responds with `Chat Server Running`; `/health` and `/socket.io/` verify service health and realtime connectivity.

The checked-in Blueprint uses Render's free plan, which runs one instance. This is suitable for a small demo; it does not provide unlimited concurrent users or high availability. Free instances can also spin down when idle.

## Scaling to multiple instances

Socket.IO uses WebSocket transport so connections do not depend on HTTP polling stickiness. To run more than one server instance:

1. Create a Render Key Value service in the same region as the web service.
2. Set the web service's `REDIS_URL` to the Key Value **internal** connection URL.
3. Upgrade the web service from the free plan, then scale it to the required instance count in Render.

When `REDIS_URL` is set, the Socket.IO Redis adapter shares message broadcasts across instances. Redis also shares online-user presence; leases expire after missed heartbeats so users from a crashed instance do not stay online forever. `/health` checks Redis readiness when Redis is configured. Without `REDIS_URL`, one server instance uses in-memory presence and messaging.

The sidebar lists at most 100 users to keep presence updates small; the active count includes all connected users. “Saved messages” persist in that browser's local storage. General and direct messages are not stored on the server, and direct messages can only be sent to online contacts. Capacity depends on instance size, message rate, network usage, and Redis performance, so measure with expected traffic before promising a user limit.
