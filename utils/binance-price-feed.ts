interface BinanceTradeMessage {
  s?: string;
  p?: string;
}

interface BinancePriceFeedConfig {
  symbol: string;
  onPrice: (price: number) => void;
}

export interface BinancePriceFeedStatus {
  symbol: string;
  streamUrl: string;
  isConnected: boolean;
  lastPrice: number | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
}

export function createBinancePriceFeed(config: BinancePriceFeedConfig) {
  const streamUrl = `wss://stream.binance.com:9443/ws/${config.symbol}@trade`;

  const status: BinancePriceFeedStatus = {
    symbol: config.symbol,
    streamUrl,
    isConnected: false,
    lastPrice: null,
    lastUpdatedAt: null,
    lastError: null,
  };

  let socket: WebSocket | null = null;
  let shouldReconnect = true;
  let reconnectTimer: Timer | null = null;

  function start() {
    shouldReconnect = true;
    connect();
  }

  function stop() {
    shouldReconnect = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  }

  function getStatus() {
    return { ...status };
  }

  function connect() {
    socket = new WebSocket(streamUrl);

    socket.onopen = () => {
      status.isConnected = true;
      status.lastError = null;
    };

    socket.onmessage = (event) => {
      const price = parseTradePrice(event.data);
      if (!price) return;

      status.lastPrice = price;
      status.lastUpdatedAt = new Date().toISOString();
      config.onPrice(price);
    };

    socket.onerror = () => {
      status.lastError = `Binance websocket error for ${config.symbol}`;
    };

    socket.onclose = () => {
      status.isConnected = false;
      if (!shouldReconnect) return;

      reconnectTimer = setTimeout(connect, 1_000);
    };
  }

  return {
    start,
    stop,
    getStatus,
  };
}

function parseTradePrice(data: unknown) {
  if (typeof data !== "string") return null;

  try {
    const message = JSON.parse(data) as BinanceTradeMessage;
    const price = Number(message.p);

    if (!Number.isFinite(price) || price <= 0) return null;

    return price;
  } catch {
    return null;
  }
}
