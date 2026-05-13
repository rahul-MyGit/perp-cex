import express from "express";
import { z } from "zod";

interface User {
  userId: string;
  balance: number;
}

interface Order {
  orderId: string;
  userId: string;
  side: OrderSide;
  price: number;
  quantity: number;
  remainingQuantity: number;
  leverage: number;
  createdAt: string;
}

interface Trade {
  tradeId: string;
  price: number;
  quantity: number;
  buyerUserId: string;
  sellerUserId: string;
  createdAt: string;
}

interface Position {
  positionId: string;
  userId: string;
  side: PositionSide;
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  unrealizedPnl: number;
  fundingPnl: number;
  equity: number;
  createdAt: string;
}

type OrderSide = "buy" | "sell";
type PositionSide = "long" | "short";

const orderSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  side: z.enum(["buy", "sell"]),
  price: z.number().positive("price must be a positive number"),
  quantity: z.number().positive("quantity must be a positive number"),
  leverage: z.number().positive("leverage must be a positive number"),
  markPrice: z.number().positive("markPrice must be a positive number").optional(),
});

const markPriceSchema = z.object({
  markPrice: z.number().positive("markPrice must be a positive number"),
});

interface OrderInput extends z.infer<typeof orderSchema> {}

const app = express();
const port = Number(process.env.PORT ?? 3001);
const maxFundingRate = 0.0075;

const users = new Map<string, User>([
  ["alice", { userId: "alice", balance: 100_000 }],
  ["bob", { userId: "bob", balance: 100_000 }],
]);

const bids: Order[] = [];
const asks: Order[] = [];
const trades: Trade[] = [];
const positions: Position[] = [];

let markPrice = 100_000;
let fundingRate = 0;

app.use(express.json());

app.get("/", (_request, response) => {
  response.json({
    message: "Perp CEX demo backend",
    endpoints: ["POST /order", "POST /mark-price", "GET /state"],
  });
});

app.post("/order", (request, response) => {
  const parsedOrder = orderSchema.safeParse(request.body);

  if (!parsedOrder.success) {
    response.status(400).json({ error: formatZodError(parsedOrder.error) });
    return;
  }

  const orderInput = parsedOrder.data;
  const user = getOrCreateUser(orderInput.userId);
  const requiredMargin = getRequiredMargin(
    orderInput.price,
    orderInput.quantity,
    orderInput.leverage,
  );

  if (user.balance < requiredMargin) {
    response.status(400).json({
      error: "insufficient balance for required margin",
      balance: user.balance,
      requiredMargin,
    });
    return;
  }

  if (orderInput.markPrice) markPrice = orderInput.markPrice;

  user.balance -= requiredMargin;

  const order = createOrder(orderInput);
  const matchedTrades = matchOrder(order);

  if (order.remainingQuantity > 0) addOpenOrder(order);

  refreshPricing();

  response.status(201).json({
    order,
    trades: matchedTrades,
    user,
    markPrice,
    fundingRate,
    orderbook: getOrderbookSnapshot(),
    positions: getUserPositions(order.userId),
  });
});

app.post("/mark-price", (request, response) => {
  const parsedBody = markPriceSchema.safeParse(request.body);

  if (!parsedBody.success) {
    response.status(400).json({ error: formatZodError(parsedBody.error) });
    return;
  }

  markPrice = parsedBody.data.markPrice;
  refreshPricing();

  response.json({
    markPrice,
    fundingRate,
    positions,
  });
});

app.get("/state", (_request, response) => {
  response.json({
    users: Array.from(users.values()),
    markPrice,
    fundingRate,
    orderbook: getOrderbookSnapshot(),
    trades,
    positions,
  });
});

app.listen(port, () => {
  console.log(`Perp CEX demo backend on http://localhost:${port}`);
});

function getOrCreateUser(userId: string) {
  const existingUser = users.get(userId);
  if (existingUser) return existingUser;

  const user: User = {
    userId,
    balance: 100_000,
  };

  users.set(userId, user);
  return user;
}

function createOrder(order: OrderInput): Order {
  return {
    orderId: createId("order"),
    userId: order.userId,
    side: order.side,
    price: order.price,
    quantity: order.quantity,
    remainingQuantity: order.quantity,
    leverage: order.leverage,
    createdAt: new Date().toISOString(),
  };
}

function matchOrder(order: Order) {
  return order.side === "buy" ? matchBuyOrder(order) : matchSellOrder(order);
}

function matchBuyOrder(order: Order) {
  const matchedTrades: Trade[] = [];
  sortAsks();

  for (const ask of asks) {
    if (order.remainingQuantity <= 0) break;
    if (ask.price > order.price) break;

    const tradeQuantity = Math.min(order.remainingQuantity, ask.remainingQuantity);
    const trade = createTrade({
      price: ask.price,
      quantity: tradeQuantity,
      buyerUserId: order.userId,
      sellerUserId: ask.userId,
    });

    order.remainingQuantity -= tradeQuantity;
    ask.remainingQuantity -= tradeQuantity;
    trades.push(trade);
    matchedTrades.push(trade);

    createPosition(order.userId, "long", trade.price, trade.quantity, order.leverage);
    createPosition(ask.userId, "short", trade.price, trade.quantity, ask.leverage);
  }

  removeFilledOrders(asks);
  return matchedTrades;
}

function matchSellOrder(order: Order) {
  const matchedTrades: Trade[] = [];
  sortBids();

  for (const bid of bids) {
    if (order.remainingQuantity <= 0) break;
    if (bid.price < order.price) break;

    const tradeQuantity = Math.min(order.remainingQuantity, bid.remainingQuantity);
    const trade = createTrade({
      price: bid.price,
      quantity: tradeQuantity,
      buyerUserId: bid.userId,
      sellerUserId: order.userId,
    });

    order.remainingQuantity -= tradeQuantity;
    bid.remainingQuantity -= tradeQuantity;
    trades.push(trade);
    matchedTrades.push(trade);

    createPosition(bid.userId, "long", trade.price, trade.quantity, bid.leverage);
    createPosition(order.userId, "short", trade.price, trade.quantity, order.leverage);
  }

  removeFilledOrders(bids);
  return matchedTrades;
}

function createTrade(trade: {
  price: number;
  quantity: number;
  buyerUserId: string;
  sellerUserId: string;
}): Trade {
  return {
    tradeId: createId("trade"),
    price: trade.price,
    quantity: trade.quantity,
    buyerUserId: trade.buyerUserId,
    sellerUserId: trade.sellerUserId,
    createdAt: new Date().toISOString(),
  };
}

function createPosition(
  userId: string,
  side: PositionSide,
  entryPrice: number,
  quantity: number,
  leverage: number,
) {
  const margin = getRequiredMargin(entryPrice, quantity, leverage);

  positions.push({
    positionId: createId("position"),
    userId,
    side,
    entryPrice,
    quantity,
    leverage,
    margin,
    unrealizedPnl: 0,
    fundingPnl: 0,
    equity: margin,
    createdAt: new Date().toISOString(),
  });
}

function addOpenOrder(order: Order) {
  if (order.side === "buy") {
    bids.push(order);
    sortBids();
    return;
  }

  asks.push(order);
  sortAsks();
}

function refreshPricing() {
  updateUnrealizedPnl();
  updateFundingRate();
  applyFunding();
  updateEquity();
}

function updateUnrealizedPnl() {
  for (const position of positions) {
    position.unrealizedPnl =
      position.side === "long"
        ? (markPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - markPrice) * position.quantity;
  }
}

function updateFundingRate() {
  const midPrice = getMidPrice();
  if (!midPrice) {
    fundingRate = 0;
    return;
  }

  const rawFundingRate = (midPrice - markPrice) / markPrice;
  fundingRate = clamp(rawFundingRate, -maxFundingRate, maxFundingRate);
}

function applyFunding() {
  if (fundingRate === 0) return;

  const payingSide: PositionSide = fundingRate > 0 ? "long" : "short";
  const receivingSide: PositionSide = fundingRate > 0 ? "short" : "long";
  const payingPositions = positions.filter((position) => position.side === payingSide);
  const receivingPositions = positions.filter((position) => position.side === receivingSide);
  const totalReceivingNotional = receivingPositions.reduce(
    (total, position) => total + getPositionNotional(position),
    0,
  );

  if (payingPositions.length === 0 || totalReceivingNotional === 0) return;

  let totalFundingPaid = 0;

  for (const position of payingPositions) {
    const payment = getPositionNotional(position) * Math.abs(fundingRate);
    position.fundingPnl -= payment;
    totalFundingPaid += payment;
  }

  for (const position of receivingPositions) {
    const receiveShare = getPositionNotional(position) / totalReceivingNotional;
    position.fundingPnl += totalFundingPaid * receiveShare;
  }
}

function getPositionNotional(position: Position) {
  return position.entryPrice * position.quantity;
}

function updateEquity() {
  for (const position of positions) {
    position.equity = position.margin + position.unrealizedPnl + position.fundingPnl;
  }
}

function getMidPrice() {
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;

  if (!bestBid || !bestAsk) return null;
  return (bestBid + bestAsk) / 2;
}

function getOrderbookSnapshot() {
  return {
    bids: bids.map(toPublicOrder),
    asks: asks.map(toPublicOrder),
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    midPrice: getMidPrice(),
  };
}

function getUserPositions(userId: string) {
  return positions.filter((position) => position.userId === userId);
}

function toPublicOrder(order: Order) {
  return {
    orderId: order.orderId,
    userId: order.userId,
    side: order.side,
    price: order.price,
    quantity: order.quantity,
    remainingQuantity: order.remainingQuantity,
    leverage: order.leverage,
    createdAt: order.createdAt,
  };
}

function getRequiredMargin(price: number, quantity: number, leverage: number) {
  return (price * quantity) / leverage;
}

function removeFilledOrders(orderbookSide: Order[]) {
  for (let index = orderbookSide.length - 1; index >= 0; index -= 1) {
    if (orderbookSide[index]?.remainingQuantity === 0) orderbookSide.splice(index, 1);
  }
}

function sortBids() {
  bids.sort((leftOrder, rightOrder) => rightOrder.price - leftOrder.price);
}

function sortAsks() {
  asks.sort((leftOrder, rightOrder) => leftOrder.price - rightOrder.price);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => issue.message).join(", ");
}
