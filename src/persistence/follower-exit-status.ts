import type { SqliteDatabase } from "./database.js";

export interface FollowerExitStatus {
  readonly positionId: number;
  readonly followerWallet: string;
  readonly leaderWallet: string;
  readonly tokenMint: string;
  readonly quoteMint: string;
  readonly remainingTokenRaw: bigint;
  readonly remainingCostQuoteRaw: bigint;
  readonly status:
    | "OPEN_WITHOUT_OBSERVED_FULL_EXIT"
    | "SOURCE_FULL_EXIT_WITH_FOLLOWER_REMAINDER";
  readonly fullExitSourceIds: readonly string[];
  readonly lastExitReason: string | null;
}

/** Durable evidence projection, not a liquidation policy or a mark price.
 * A source full exit is proven by S=B>0, never by leader_positions.state. */
export function readFollowerExitStatuses(
  database: SqliteDatabase,
): readonly FollowerExitStatus[] {
  return database.sqlite.transaction(() => {
    const positions = database.sqlite
      .prepare(
        `SELECT p.*, fw.address follower_wallet, lw.address leader_wallet
      FROM follower_positions p JOIN wallets fw ON fw.id=p.follower_wallet_id JOIN wallets lw ON lw.id=p.leader_wallet_id
      WHERE p.state='OPEN' AND p.accounting_policy_version='WEIGHTED_AVERAGE_V1' ORDER BY p.id`,
      )
      .all() as {
      id: number;
      follower_wallet_id: number;
      leader_wallet_id: number;
      follower_wallet: string;
      leader_wallet: string;
      token_mint: string;
      quote_mint: string;
      raw_amount: string;
      total_cost_quote_raw: string;
    }[];
    return positions
      .filter((p) => BigInt(p.raw_amount) > 0n)
      .map((p) => {
        const opening = database.sqlite
          .prepare(
            `SELECT l.id, l.created_at_ms, l.slot FROM paper_fill_applications a
        JOIN paper_fills f ON f.id=a.fill_id JOIN leader_trades l ON l.id=f.leader_trade_id
        WHERE a.position_id=? AND a.transition='OPEN' ORDER BY a.position_version_after DESC LIMIT 1`,
          )
          .get(p.id) as
          { id: string; created_at_ms: number; slot: string } | undefined;
        const exits =
          opening === undefined
            ? []
            : (
                database.sqlite
                  .prepare(
                    `SELECT l.id, l.token_raw, l.leader_pre_token_raw, l.slot,
        COALESCE(r.reason_code, ft.skip_reason) reason
        FROM leader_trades l LEFT JOIN follower_trades ft ON ft.leader_trade_id=l.id AND ft.follower_wallet_id=?
        LEFT JOIN risk_decisions r ON r.intent_id=ft.execution_key AND r.decision IN ('REJECT','HALT')
        WHERE l.leader_wallet_id=? AND l.token_mint=? AND l.quote_mint=? AND l.side='SELL' AND l.created_at_ms>=?
        ORDER BY l.created_at_ms, l.id`,
                  )
                  .all(
                    p.follower_wallet_id,
                    p.leader_wallet_id,
                    p.token_mint,
                    p.quote_mint,
                    opening.created_at_ms,
                  ) as {
                  id: string;
                  token_raw: string;
                  leader_pre_token_raw: string;
                  slot: string;
                  reason: string | null;
                }[]
              ).filter((row) => BigInt(row.slot) >= BigInt(opening.slot));
        const fullExitSourceIds = [
          ...new Set(
            exits
              .filter(
                (row) =>
                  BigInt(row.token_raw) > 0n &&
                  BigInt(row.token_raw) === BigInt(row.leader_pre_token_raw),
              )
              .map((row) => row.id),
          ),
        ];
        return {
          positionId: p.id,
          followerWallet: p.follower_wallet,
          leaderWallet: p.leader_wallet,
          tokenMint: p.token_mint,
          quoteMint: p.quote_mint,
          remainingTokenRaw: BigInt(p.raw_amount),
          remainingCostQuoteRaw: BigInt(p.total_cost_quote_raw),
          status: fullExitSourceIds.length
            ? ("SOURCE_FULL_EXIT_WITH_FOLLOWER_REMAINDER" as const)
            : ("OPEN_WITHOUT_OBSERVED_FULL_EXIT" as const),
          fullExitSourceIds,
          lastExitReason: exits.at(-1)?.reason ?? null,
        };
      });
  })();
}
