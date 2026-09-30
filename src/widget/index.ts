/**
 * uvd-describe-sdk/widget — ONE component for "a describe.net score, with its
 * credit", for every surface of the stack.
 *
 * ```ts
 * import { defineDescribeScore } from 'uvd-describe-sdk/widget';
 * defineDescribeScore(); // registers <describe-score>; nothing registers on import
 * ```
 * ```html
 * <describe-score score="83.0" wallet="0x97cd…0996" reviews="123" lang="es"></describe-score>
 * ```
 *
 * ## Why this exists (2026-09-30)
 *
 * The owner hovered a reputation in Execution Market and got the browser's grey
 * `title=` box saying "Powered by describe.net"; in KarmaKadabra the same number
 * opened a styled card. Three repos had solved "the number, with credit" three
 * ways (EM `AttributedScore.tsx`, MeshRelay `Leaderboard.tsx` / `AgentPage.tsx`,
 * KK `agent.js` `_tarjetaDescribe()`), and the house rule for that is: one
 * component, best of each side upstream first. What came from where:
 *
 *   * **KarmaKadabra** — the card itself: brand mark, seal, the sentence, the
 *     rows that appear only when their datum came, the raw-date fallback, hover
 *     AND focus, `tabindex` on a face with no link, reduced motion, and building
 *     every node with `textContent`.
 *   * **Execution Market** — the credit, verbatim and never translated; the link
 *     rule (`?wallet=`, else `?q=`, else NO link — never an invented one); only
 *     the digits on the face; the three languages (es/en/pt).
 *   * **MeshRelay** — the face can be anything the host renders (their bar), and
 *     an absent score is stated, never drawn as an empty (zero) bar.
 *
 * ## It makes no network call, and that is what allows it to exist
 *
 * describe.net deliberately publishes no widget (`describenet/badge.py:13-18`):
 * only an `<img>` + SVG, because a site that embeds a widget which TRANSMITS data
 * is co-responsible for it (EFF 2010, *Fashion ID*), and because a `fetch` per
 * pageview would burn their shared rate limit. This component does not
 * contradict that: it fetches nothing, loads no image or font, and paints only
 * what the host already holds from its own read. It is a way to DRAW a number,
 * not a way to GET one — reading stays with `DescribeClient` on the host's
 * server, with its caveats, its jitter and its fail-open rules.
 *
 * ## null is never 0
 *
 * An absent, empty or non-numeric `score` renders "no data" in the page's
 * language — the same rule as the index's invariant and this SDK's R1. There is
 * no attribute that turns an absence into a number.
 */

export {
  DESCRIBE_ATTRIBUTION,
  buildDescribeScoreCard,
  type DescribeScoreCard,
  type DescribeScoreCardRow,
  type DescribeScoreData,
  type DescribeScoreLang,
} from './card';
export { defineDescribeScore, type DescribeScoreElement } from './element';

import type { DescribeScoreElement } from './element';

declare global {
  interface HTMLElementTagNameMap {
    'describe-score': DescribeScoreElement;
  }
}
