/**
 * What the page weighs. There is no build step here: the two stylesheets are shipped as written,
 * and nothing else in the repo watches their size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/**
 * The two sheets are the whole of the page's styling — there is no build step to shrink them — so
 * a ceiling here is the only thing standing between a working page and a slow one. The numbers are
 * a little above what the sheets weigh today and they are meant to be raised deliberately, with a
 * reason, not drifted past.
 *
 * Raised 2026-09-16 from 27 000 to 30 500: the identity round added a mark, a real class for the
 * secondary buttons (which replaced three half-classes, so most of that came back), rows in the
 * system list that carry a version and an address to copy, and the footer the deployment fills in
 * from site.json. Style stood at 25 541 B before the round and at 29 495 B after; theme did not
 * move. Gzipped that is roughly 7.4 KB, still one small request.
 *
 * Raised again 2026-09-16, 30 500 to 35 000 (style stood at 29 665 B before this round). The
 * design-QC round stopped borrowing the browser's own controls: the checkbox and the device list
 * are drawn here now, in one language and in both themes, which is most of the new weight. The
 * rest is the row in the system list becoming the action it always was (a chevron, and Copy link
 * a level quieter), the status lamps turning into one lens instead of a ring inside a ring, and
 * a 44px target under the 30px "?" ring. Nothing here is decoration: every block replaces a
 * control the platform was painting for us in its own colours. Reason for the round and the list
 * of moves: docs/design/2026-09-16-tozsamosc-i-stopka.md.
 */
/*
 * Raised once more 2026-09-16, 35 000 to 36 500 (style stood at 34 474 B before this round). The
 * round before publication spent it on three things, all of them removals of a difference rather
 * than additions of decoration: the blocking message became one component instead of three
 * appearances (that rule replaced two others, so it nearly paid for itself), a test release got
 * the tag it already wears on the install screen repeated in the row that offers it, and the
 * erase key became filled amber with a hover of its own so the heavy answer in that dialog no
 * longer weighs the same as the harmless one. Reason for the round: docs/qc/2026-09-16-design-qc-2.md.
 */
/*
 * Raised once more 2026-09-16, 36 500 to 37 500 (style stood at 36 118 B before this round). The
 * round that closed the five lighter findings of the first design-QC spent it on four rules and
 * the reasoning beside them: one axis on the plate (the note and the quiet link stop being
 * centred), a button that is off becoming a well with the plate's quiet ink instead of the accent
 * faded to 2.57:1, the kicker leaving the done screen because "install this" has by then been
 * carried out, and a stable scrollbar gutter so the page cannot change width while the browser's
 * port window is open. Two of the four are one declaration each; the weight is mostly the note
 * that says why, which is the house rule here. Reason for the round:
 * docs/qc/2026-09-16-design-qc.md (F7, F10, F13).
 */
const CEILING = { 'style.css': 37500, 'theme.css': 5200 };

test('neither stylesheet has grown past its ceiling', () => {
  const over = Object.entries(CEILING)
    .map(([name, max]) => [name, Buffer.byteLength(read(name)), max])
    .filter(([, size, max]) => size > max);
  assert.deepEqual(over, [], 'raise the ceiling in this test and write down why, or take weight out');
});
