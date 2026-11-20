import type { Game } from './lib'

/** How long after a vote closes its result still pops up for someone opening the table. */
export const VERDICT_RECENT_MS = 2 * 60_000

/**
 * Which finished games the "Vote closed" sheet should announce: results of the table's latest
 * round only, finalized in the last two minutes, not shown before. Once the host has started a
 * new round, the previous round's results never pop up, even for someone who opens the table a
 * moment later; their place is the "Recent results" list.
 */
export function pickVerdicts(
  games: Game[],
  latestRoundId: string | undefined,
  now: number,
  shown: ReadonlySet<string>,
): Game[] {
  return games
    .filter(
      g =>
        (g.state === 'confirmed' || g.state === 'tied') &&
        g.round_id === latestRoundId &&
        g.finalized_at !== null &&
        now - new Date(g.finalized_at).getTime() < VERDICT_RECENT_MS &&
        !shown.has(g.id),
    )
    .sort((x, y) => x.slot - y.slot)
}
