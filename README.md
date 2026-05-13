# Perp CEX Backend Demo

Small inmemory Express backend for learning how a perpetual futures CEX handles
orders, long/short positions, mark price, PnL, and funding rate.

State is stored in memory, so it resets every time the server restarts.

## Install

```bash
bun install
```

## Run

```bash
bun run index.ts
```

Server runs on:

```text
http://localhost:3001
```

## Core Logic

- `buy` order creates a long position when matched.
- `sell` order creates a short position when matched.
- Required margin is calculated as:

```text
margin = price * quantity / leverage
```

- Long PnL:

```text
(markPrice - entryPrice) * quantity
```

- Short PnL:

```text
(entryPrice - markPrice) * quantity
```

- Orderbook mid price:

```text
(bestBid + bestAsk) / 2
```

- Funding rate:

```text
(midPrice - markPrice) / markPrice
```

Funding is capped to `+/-0.75%`.

If funding is positive, longs pay shorts. If funding is negative, shorts pay
longs. Funding is zero-sum in this demo: the receiving side only receives the
exact amount paid by the paying side, distributed by position size.

## Test The Backend

### 1. Check Server

```bash
curl http://localhost:3001
```

### 2. Place A Sell Order

Bob places an ask at `100000`. This will sit in the orderbook until someone
buys from him.

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "bob",
    "side": "sell",
    "price": 100000,
    "quantity": 1,
    "leverage": 10,
    "markPrice": 100000
  }'
```

Expected result:

- Bob balance decreases by margin.
- No trade yet.
- Sell order appears in `asks`.

### 3. Place A Matching Buy Order

Alice buys at the same price, so her order matches Bob's sell order.

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "side": "buy",
    "price": 100000,
    "quantity": 1,
    "leverage": 10,
    "markPrice": 100000
  }'
```

Expected result:

- One trade is created.
- Alice gets a long position.
- Bob gets a short position.
- Both users used `10000` margin:

```text
100000 * 1 / 10 = 10000
```

### 4. Inspect Full State

```bash
curl http://localhost:3001/state
```

You should see:

- users
- current mark price
- funding rate
- orderbook
- trades
- positions

## Test PnL Change

Move mark price up to `101000`.

```bash
curl -X POST http://localhost:3001/mark-price \
  -H "Content-Type: application/json" \
  -d '{
    "markPrice": 101000
  }'
```

Expected result:

- Alice long profit becomes `+1000`.
- Bob short loss becomes `-1000`.

Because:

```text
long PnL = 101000 - 100000 = 1000
short PnL = 100000 - 101000 = -1000
```

## Test Funding Rate

Funding only works when the orderbook has both:

- one open bid
- one open ask

That is because this demo calculates exchange perp price using:

```text
midPrice = (bestBid + bestAsk) / 2
```

To test funding clearly, restart the server first so state is clean.

### 1. Create A Real Trade First

Create an ask from Bob:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "bob",
    "side": "sell",
    "price": 100000,
    "quantity": 1,
    "leverage": 10,
    "markPrice": 100000
  }'
```

Match it with Alice:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "alice",
    "side": "buy",
    "price": 100000,
    "quantity": 1,
    "leverage": 10,
    "markPrice": 100000
  }'
```

Now Alice has a long and Bob has a short.

### 2. Add Open Orders To Create Mid Price

Add a bid below the market:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "carol",
    "side": "buy",
    "price": 100500,
    "quantity": 1,
    "leverage": 10,
    "markPrice": 100000
  }'
```

Add an ask above the market:

```bash
curl -X POST http://localhost:3001/order \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "dave",
    "side": "sell",
    "price": 101500,
    "quantity": 1,
    "leverage": 10,
    "markPrice": 100000
  }'
```

Now:

```text
bestBid = 100500
bestAsk = 101500
midPrice = 101000
markPrice = 100000
fundingRate = (101000 - 100000) / 100000 = 0.01
```

The backend caps funding to `0.0075`, so the final funding rate is:

```text
0.75%
```

Because funding is positive:

- longs pay funding
- shorts receive funding

Alice's long funding PnL decreases. Bob's short funding PnL increases.

In this example, Alice and Bob both have the same `100000` notional, so:

```text
Alice pays 100000 * 0.0075 = 750
Bob receives 750
```

If there are many shorts, they split the received funding by position notional.
For example, if Bob has `40%` of short notional and Charlie has `60%`, Bob gets
`40%` of the funding and Charlie gets `60%`.

### 3. Inspect Funding State

```bash
curl http://localhost:3001/state
```

Look for:

- `fundingRate`
- Alice's `fundingPnl`
- Bob's `fundingPnl`
- each position's `equity`

Note: this is a teaching demo. Funding is applied each time pricing refreshes,
not on a production-style hourly or 8-hour schedule.

## Test Zod Validation

Invalid request:

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

Expected result:

```text
400 Bad Request
```

The backend uses Zod schemas to validate request bodies.

