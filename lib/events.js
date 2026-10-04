// Server-sent events so every host-stand device updates the moment a booking
// lands. One long-lived response per open tab; no websockets, no broker.

export function createEventHub({ heartbeatMs = 25_000 } = {}) {
  const clients = new Map();

  const timer = setInterval(() => {
    for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
  }, heartbeatMs);
  timer.unref();

  return {
    subscribe(restaurantId, req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      if (!clients.has(restaurantId)) clients.set(restaurantId, new Set());
      clients.get(restaurantId).add(res);
      const drop = () => {
        clients.get(restaurantId)?.delete(res);
        if (clients.get(restaurantId)?.size === 0) clients.delete(restaurantId);
      };
      req.on('close', drop);
      res.on('error', drop);
    },

    publish(restaurantId, event) {
      const set = clients.get(restaurantId);
      if (!set) return;
      const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of set) res.write(data);
    },

    count(restaurantId) {
      return clients.get(restaurantId)?.size ?? 0;
    },

    close() {
      clearInterval(timer);
      for (const set of clients.values()) for (const res of set) res.end();
      clients.clear();
    },
  };
}
