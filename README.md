# Perp CEX Backend

In-memory Express backend for a SOL/USDT perpetual exchange. It supports limit
orders, order matching, long/short positions, live Binance index pricing,
unrealized PnL, and scheduled funding payments.

State is stored in memory and resets when the server restarts.

## Setup

```bash
bun install
```

## Run

```bash
bun run index.ts
```

The server runs on:

```text
http://localhost:3001
```

The backend subscribes to Binance's `solusdt@trade` stream:

```text
wss://stream.binance.com:9443/ws/solusdt@trade
```

The frontend only submits orders. It does not send `indexPrice` or `markPrice`.

## Configuration

Funding settles every 8 hours by default.

```bash
FUNDING_INTERVAL_HOURS=8 bun run index.ts
```

For a 1-hour interval:

```bash
FUNDING_INTERVAL_HOURS=1 bun run index.ts
```

## Exchange Logic

- `buy` orders open long positions when matched.
- `sell` orders open short positions when matched.
- Required margin is `price * quantity / leverage`.
- `indexPrice` comes from Binance `SOLUSDT`.
- `markPrice` follows `indexPrice`.
- Long PnL is `(markPrice - entryPrice) * quantity`.
- Short PnL is `(entryPrice - markPrice) * quantity`.
- Perp mid price is `(bestBid + bestAsk) / 2`.
- Funding rate is `(midPrice - indexPrice) / indexPrice`.
- Funding is capped to `+/-0.75%`.
- Funding is zero-sum: the paying side loses exactly what the receiving side receives.

## Check State

```bash
curl http://localhost:3001/state
```

Useful fields:

- `indexPrice`
- `markPrice`
- `fundingRate`
- `lastFundingAt`
- `nextFundingAt`
- `priceFeed`
- `orderbook`
- `trades`
- `positions`

## Place Orders

Use a price close to the live `indexPrice` returned by `/state`.

Place an ask:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "bob",
    "side": "sell",
    "price": 95,
    "quantity": 1,
    "leverage": 10
  }'
```

Place a matching bid:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "side": "buy",
    "price": 95,
    "quantity": 1,
    "leverage": 10
  }'
```

Expected result:

- One trade is created.
- Alice receives a long position.
- Bob receives a short position.
- Margin is deducted from both users.

## Funding

Funding requires both an open bid and an open ask so the exchange can calculate
mid price:

```text
midPrice = (bestBid + bestAsk) / 2
fundingRate = (midPrice - indexPrice) / indexPrice
```

If `midPrice` is above `indexPrice`, funding is positive and longs pay shorts.
If `midPrice` is below `indexPrice`, funding is negative and shorts pay longs.

`fundingRate` updates with pricing changes. `fundingPnl` updates only when the
funding interval settles.

## Validation

Invalid order example:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "",
    "side": "hold",
    "price": -1,
    "quantity": 0,
    "leverage": 0
  }'
```

Expected response:

```text
400 Bad Request
```

# TODO TO ATTEMPT
- currently marketprice = indexPrice , now ( add some premium to indexPrice)
- close position logic + realised PnL
- position netting (A buy 2 SOL and sell 1 SOL then reduce long to 1 SOL)
- liquidation engine
- multiple price aggregator
- order type
bla bla