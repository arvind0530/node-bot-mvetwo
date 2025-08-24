/**
 * EMA crossover bot (LONG+SHORT) with Mongo Atlas (native driver) + Express APIs
 * - Entry EMA crossover (open trade)
 * - Exit EMA crossover (close trade)
 *
 * Install:
 *   npm i axios technicalindicators express cors dotenv mongodb
 *
 * .env example:
 *   MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>/
 *   DB_NAME=btcbotema
 *   SYMBOL=BTCUSDT
 *   INTERVAL=1m
 *   EMA_ENTRY_FAST=7
 *   EMA_ENTRY_SLOW=10
 *   EMA_EXIT_FAST=20
 *   EMA_EXIT_SLOW=50
 *   DRY_RUN=false
 *   PORT=4000
 */

import axios from "axios";
import { EMA } from "technicalindicators";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

/* ========= Config ========= */
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";

// Entry EMAs
const EMA_ENTRY_FAST = Number(process.env.EMA_ENTRY_FAST || 20);
const EMA_ENTRY_SLOW = Number(process.env.EMA_ENTRY_SLOW || 50);

// Exit EMAs
const EMA_EXIT_FAST = Number(process.env.EMA_EXIT_FAST || 9);
const EMA_EXIT_SLOW = Number(process.env.EMA_EXIT_SLOW || 21);

if (EMA_ENTRY_FAST >= EMA_ENTRY_SLOW) {
  console.warn("[WARN] EMA_ENTRY_FAST should be < EMA_ENTRY_SLOW");
}
if (EMA_EXIT_FAST >= EMA_EXIT_SLOW) {
  console.warn("[WARN] EMA_EXIT_FAST should be < EMA_EXIT_SLOW");
}

const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const PORT = Number(process.env.PORT || 4444);

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://ArvindETH:Arvind2001@tracktohack.2rudkmv.mongodb.net/?retryWrites=true&w=majority&appName=TrackToHack";
const DB_NAME = process.env.DB_NAME || "btcbotematwo";

const API_URL = "https://api.binance.com/api/v3/klines";

/* ========= Mongo (native driver) ========= */
let mongoClient;
let db;
let positionsCol; // collection: positions

async function connectMongo() {
  if (DRY_RUN) return;
  if (mongoClient) return;

  mongoClient = new MongoClient(MONGO_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  positionsCol = db.collection("positions");

  await positionsCol.createIndex({ status: 1, symbol: 1, createdAt: -1 });
  await positionsCol.createIndex({ symbol: 1, positionType: 1, createdAt: -1 });

  console.log(`[${ts()}] ✅ Mongo connected (db=${DB_NAME})`);
}

/* ========= State ========= */
let isTickRunning = false;
let openPosition = null;
let cached = {
  price: null,
  emaEntryFast: null,
  emaEntrySlow: null,
  emaExitFast: null,
  emaExitSlow: null,
  entrySignal: "NONE",
  exitSignal: "NONE",
  lastTickAt: null,
};

/* ========= Utils ========= */
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function detectCross(prevFast, prevSlow, fast, slow) {
  if (prevFast < prevSlow && fast > slow) return "GOLDEN";
  if (prevFast > prevSlow && fast < slow) return "DEATH";
  return "NONE";
}

async function restoreOpenPosition() {
  if (DRY_RUN) return;
  const doc = await positionsCol
    .find({ symbol: SYMBOL, status: "OPEN" })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  openPosition = doc[0] || null;
}

async function fetchCloses(
  limit = Math.max(EMA_ENTRY_SLOW, EMA_EXIT_SLOW) + 50
) {
  const url = `${API_URL}?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 12_000 });
  return data.map((k) => Number(k[4]));
}

/* ========= Trade Ops ========= */
async function openTrade({ positionType, price, emaFast, emaSlow }) {
  const base = {
    symbol: SYMBOL,
    status: "OPEN",
    qty: 1,
    positionType,
    entryPrice: price,
    entryTime: new Date(),
    entryEMAfast: emaFast,
    entryEMAslow: emaSlow,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (DRY_RUN) {
    openPosition = { _id: "dryrun", ...base };
    console.log(`[${ts()}] 🟢 OPEN ${positionType} (DRY_RUN) @ ${price}`);
    return;
  }
  const { insertedId } = await positionsCol.insertOne(base);
  openPosition = { _id: insertedId, ...base };
  console.log(`[${ts()}] 🟢 OPEN ${positionType} @ ${price} (id=${insertedId})`);
}

async function closeTrade({ price, emaFast, emaSlow }) {
  if (!openPosition) return;

  const qty = openPosition.qty || 1;
  const isLong = openPosition.positionType === "LONG";
  const pnl =
    (isLong ? price - openPosition.entryPrice : openPosition.entryPrice - price) *
    qty;

  if (DRY_RUN) {
    console.log(
      `[${ts()}] 🔴 CLOSE ${openPosition.positionType} (DRY_RUN) @ ${price} | PnL: ${pnl}`
    );
    openPosition = null;
    return;
  }

  const res = await positionsCol.findOneAndUpdate(
    { _id: openPosition._id, status: "OPEN" },
    {
      $set: {
        status: "CLOSED",
        exitPrice: price,
        exitTime: new Date(),
        exitEMAfast: emaFast,
        exitEMAslow: emaSlow,
        profitLoss: pnl,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (res?.value) {
    console.log(
      `[${ts()}] 🔴 CLOSE ${res.value.positionType} @ ${price} | PnL: ${pnl} (id=${res.value._id})`
    );
  } else {
    console.warn(`[${ts()}] ⚠️ No OPEN position found to close.`);
  }
  openPosition = null;
}

/* ========= Strategy Tick ========= */
async function tick() {
  if (isTickRunning) return;
  isTickRunning = true;
  try {
    const closes = await fetchCloses();
    if (!closes || closes.length < Math.max(EMA_ENTRY_SLOW, EMA_EXIT_SLOW)) {
      console.warn(`[${ts()}] ⚠️ Not enough candles`);
      return;
    }

    // Entry EMAs
    const entryFastArr = EMA.calculate({ period: EMA_ENTRY_FAST, values: closes });
    const entrySlowArr = EMA.calculate({ period: EMA_ENTRY_SLOW, values: closes });

    // Exit EMAs
    const exitFastArr = EMA.calculate({ period: EMA_EXIT_FAST, values: closes });
    const exitSlowArr = EMA.calculate({ period: EMA_EXIT_SLOW, values: closes });

    const fastPrevEntry = entryFastArr.at(-2);
    const slowPrevEntry = entrySlowArr.at(-2);
    const fastEntry = entryFastArr.at(-1);
    const slowEntry = entrySlowArr.at(-1);

    const fastPrevExit = exitFastArr.at(-2);
    const slowPrevExit = exitSlowArr.at(-2);
    const fastExit = exitFastArr.at(-1);
    const slowExit = exitSlowArr.at(-1);

    const price = closes.at(-1);

    const entrySignal = detectCross(fastPrevEntry, slowPrevEntry, fastEntry, slowEntry);
    const exitSignal = detectCross(fastPrevExit, slowPrevExit, fastExit, slowExit);

    cached = {
      price,
      emaEntryFast: fastEntry,
      emaEntrySlow: slowEntry,
      emaExitFast: fastExit,
      emaExitSlow: slowExit,
      entrySignal,
      exitSignal,
      lastTickAt: new Date(),
    };

    // ENTRY logic
    if (!openPosition) {
      if (entrySignal === "GOLDEN") {
        await openTrade({ positionType: "LONG", price, emaFast: fastEntry, emaSlow: slowEntry });
      } else if (entrySignal === "DEATH") {
        await openTrade({ positionType: "SHORT", price, emaFast: fastEntry, emaSlow: slowEntry });
      }
    } else {
      // EXIT logic
      if (exitSignal === "GOLDEN" && openPosition.positionType === "SHORT") {
        await closeTrade({ price, emaFast: fastExit, emaSlow: slowExit });
      } else if (exitSignal === "DEATH" && openPosition.positionType === "LONG") {
        await closeTrade({ price, emaFast: fastExit, emaSlow: slowExit });
      }
    }

    const posTxt = openPosition
      ? `${openPosition.positionType} OPEN @ ${openPosition.entryPrice}`
      : "NONE";
    console.log(
      `[${ts()}] Price=${price} EntryEMA(${EMA_ENTRY_FAST}/${EMA_ENTRY_SLOW})=${fastEntry.toFixed(
        2
      )}/${slowEntry.toFixed(2)} ExitEMA(${EMA_EXIT_FAST}/${EMA_EXIT_SLOW})=${fastExit.toFixed(
        2
      )}/${slowExit.toFixed(2)} EntrySig=${entrySignal} ExitSig=${exitSignal} Position=${posTxt}`
    );
  } catch (err) {
    console.error(`[${ts()}] ❌ Tick error:`, err.message);
  } finally {
    isTickRunning = false;
  }
}

/* ========= Express APIs ========= */
const app = express();
app.use(cors());

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    entryEmaFast: EMA_ENTRY_FAST,
    entryEmaSlow: EMA_ENTRY_SLOW,
    exitEmaFast: EMA_EXIT_FAST,
    exitEmaSlow: EMA_EXIT_SLOW,
    dryRun: DRY_RUN,
    db: DRY_RUN ? "SKIPPED" : db ? DB_NAME : "DISCONNECTED",
    position: openPosition
      ? { type: openPosition.positionType, entryPrice: openPosition.entryPrice, entryTime: openPosition.entryTime }
      : null,
    lastTickAt: cached.lastTickAt,
  });
});

app.get("/api/price", async (req, res) => {
  const stale =
    !cached.lastTickAt ||
    Date.now() - new Date(cached.lastTickAt).getTime() > 70_000;
  if (stale) await tick();
  res.json(cached);
});

app.get("/api/orders/history", async (req, res) => {
  try {
    if (DRY_RUN) return res.json(openPosition ? [openPosition] : []);
    const limit = Math.min(Number(req.query.limit || 100), 1000);
    const rows = await positionsCol
      .find({ symbol: SYMBOL })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/pnl/total", async (req, res) => {
  try {
    if (DRY_RUN) return res.json({ totalPnL: 0, count: 0 });
    const agg = await positionsCol
      .aggregate([
        { $match: { symbol: SYMBOL, status: "CLOSED" } },
        { $group: { _id: null, total: { $sum: "$profitLoss" }, count: { $sum: 1 } } },
      ])
      .toArray();
    const total = agg.length ? agg[0].total : 0;
    const count = agg.length ? agg[0].count : 0;
    res.json({ totalPnL: Number(total.toFixed(4)), count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/positions/open", async (req, res) => {
  try {
    if (DRY_RUN) return res.json(openPosition ? [openPosition] : []);
    const rows = await positionsCol
      .find({ symbol: SYMBOL, status: "OPEN" })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ========= Bootstrap ========= */
async function bootstrap() {
  if (!DRY_RUN) {
    await connectMongo();
    await restoreOpenPosition();
  } else {
    console.log(`[${ts()}] 🧪 DRY_RUN enabled (no DB writes)`);
  }

  app.listen(PORT, () =>
    console.log(`[${ts()}] ✅ API server on http://0.0.0.0:${PORT}`)
  );

  const now = Date.now();
  const msToMinute = 60_000 - (now % 60_000);
  setTimeout(() => {
    tick().catch(() => {});
    setInterval(() => tick().catch(() => {}), 60_000);
  }, msToMinute);

  app.get("/api/tick", async (req, res) => {
    await tick();
    res.json({ ok: true, lastTickAt: cached.lastTickAt });
  });
}

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  try {
    if (mongoClient) await mongoClient.close();
  } finally {
    process.exit(0);
  }
});

bootstrap();
