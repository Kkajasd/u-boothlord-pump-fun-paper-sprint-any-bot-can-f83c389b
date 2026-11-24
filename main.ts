// Pump.fun Paper Sprint — "fresh-coin ladder flip".
//
// Simple, deterministic, paper-only strategy for the agent-fun/replay/v2
// harness (Node 22, no network, no real funds).
//
// Idea: fresh pump.fun coins either catch a bid in their first minutes or
// bleed out. We buy a small, fixed slice of the ones that already prove
// demand — price up >= 5% from their launch price within their first
// minutes of trading, with enough real SOL in the curve that the harness
// size cap allows a real order — and we flip the whole position on a
// take-profit, a stop-loss, or a time exit so the (max 5) position slots
// keep cycling through new coins. Losers are cut fast (-15%); winners are
// given room to run (+100%) because on a 6-hour window the payoff sits in
// the few coins that run hard. No randomness, no clock: every decision
// is a pure function of the harness state, so two runs agree byte for byte.
//
// Guardrails this respects:
//   - >= 20 distinct mints, each round trip >= 0.01 SOL (we buy 0.01-0.05
//     SOL per coin and never re-buy a mint we already traded).
//   - max 5 open positions (harness cap), max 16 orders per batch.
//   - buy size never exceeds the harness 1%-of-real-reserve cap.

import {
  runBot,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- tunables (kept coarse on purpose: the scored window is a future
// 6-hour window, so nothing here is fitted to the dev dataset) ---
const BUY_MIN_SOL = 0.01; // smallest buy: the round-trip minimum bar
const BUY_MAX_SOL = 0.02; // largest buy per coin
const TRIGGER_GAIN_BPS = 500; // +5% vs launch price
const TRIGGER_MAX_TRADES = 100; // ...seen within the coin's first 100 trades
const TRIGGER_MAX_AGE_SLOTS = 4800; // ...and within ~32 min of creation
const TRIGGER_MIN_REAL_SOL = 1; // curve must hold >= 1 SOL real reserves
const TAKE_PROFIT_BPS = 20000; // sell at +100% vs entry cost per token
const STOP_LOSS_BPS = 8500; // sell at -15% vs entry cost per token
const MAX_HOLD_SLOTS = 14400; // time exit after ~4 h, win or lose
const MAX_BUYS_PER_BATCH = 2;
const SLIPPAGE_BPS = 500;

interface CoinWatch {
  launchPrice: number; // SOL per token at creation (virtual reserves ratio)
  launchSlot: number;
  bought: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createBot(): Bot {
  const watch = new Map<string, CoinWatch>();
  const entrySlot = new Map<string, number>();

  return {
    onBatch(state: BotState, _batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];

      // --- track launches and entries ---
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        let w = watch.get(mint);
        if (w === undefined) {
          if (curve.virtual_token_reserves === 0n) continue;
          w = {
            launchPrice: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves),
            launchSlot: curve.created_slot ?? state.slot,
            bought: false,
          };
          watch.set(mint, w);
        }
      }

      // --- exits first: free slots before considering new buys ---
      const pendingSell = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      }
      for (const [mint, holding] of state.positions) {
        if (pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mark = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (mark <= 0) continue;
        const entry = Number(holding.cost_lamports) / Number(holding.token_amount); // SOL/token paid
        const heldSlots = state.slot - (entrySlot.get(mint) ?? state.slot);
        const up = mark * 10_000 >= entry * TAKE_PROFIT_BPS;
        const down = mark * 10_000 <= entry * STOP_LOSS_BPS;
        if (up || down || heldSlots >= MAX_HOLD_SLOTS) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: SLIPPAGE_BPS,
          });
        }
      }

      // --- entries: fresh coins proving early demand ---
      if (state.committedPositionCount() < 5) {
        let buys = 0;
        for (const [mint, curve] of state.curves) {
          if (buys >= MAX_BUYS_PER_BATCH) break;
          if (state.committedPositionCount() + buys >= 5) break;
          if (curve.complete || curve.trades < 3 || curve.trades > TRIGGER_MAX_TRADES) continue;
          const w = watch.get(mint);
          if (w === undefined || w.bought) continue;
          if (state.positions.has(mint)) continue;
          if (state.slot - w.launchSlot > TRIGGER_MAX_AGE_SLOTS) continue;
          if (curve.real_quote_reserves < BigInt(TRIGGER_MIN_REAL_SOL) * LAMPORTS_PER_SOL) continue;
          const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (now * 10_000 < w.launchPrice * (10_000 + TRIGGER_GAIN_BPS)) continue;
          const cap = state.maxBuyLamports(mint);
          const minBuy = BigInt(Math.round(BUY_MIN_SOL * 1e9));
          if (cap < minBuy) continue;
          const maxBuy = BigInt(Math.round(BUY_MAX_SOL * 1e9));
          const size = cap < maxBuy ? cap : maxBuy;
          if (state.freeCashLamports() < size + state.txFeeLamports() * 2n) continue;
          w.bought = true;
          entrySlot.set(mint, state.slot);
          buys++;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: size,
            max_slippage_bps: SLIPPAGE_BPS,
          });
        }
      }

      return orders;
    },
  };
}

// When the harness runs this file, speak the protocol on stdin/stdout.
// (Skipped only when imported by a local test driver.)
if (process.env.MAKEFUN_BOT_TEST_IMPORT === undefined) {
  await runBot(createBot());
}
