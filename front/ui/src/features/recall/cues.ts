import type { CorpusMemory } from "@/lib/api/corpus";

/**
 * The first thing to search, derived from what is actually stored.
 *
 * A destination that holds memory but has never been queried has to offer a
 * first move, and the honest way to offer one is to read the corpus rather than
 * to ship a list of strings. Hardcoded examples are a promise about someone
 * else's data: "try: bridge collapse" is a lie on a profile of engineering
 * notes, and the moment it is wrong it teaches that nothing else on the screen
 * is trustworthy either.
 *
 * WHAT THIS READS. `CorpusMemory.tags` — the entity mentions the extraction
 * pipeline wrote at remember time, already on screen in the Inspector under
 * "Entities". Nothing here is generated, scored or rephrased; a cue is one of
 * those strings, verbatim, and clicking it runs it as the query.
 *
 * WHY THE CAPITAL LETTER IS THE FILTER. Extraction emits two very different
 * kinds of tag from the same field: named things (`Dali`, `Seagirt`,
 * `Port of Baltimore`) and ordinary sentence debris (`completed`, `week`,
 * `blocked`). Only the first kind is a cue anybody would recognise, and the
 * only signal separating them that is present on the wire is the case the
 * extractor preserved. So a group qualifies when at least one of its surface
 * forms starts with a capital — which is a filter on the DATA, not a guess
 * about it, and it degrades to "no cues" rather than to bad cues on a corpus
 * that has none.
 *
 * Counting is case-insensitive and display is not: `seagirt` (6) and `Seagirt`
 * (4) are one thing mentioned ten times, and the form shown is the capitalised
 * one because that is how a person would write it back.
 */

/** Below this a "name" is an abbreviation or noise (`bay`, `gate`, `Ltd`), and
 *  a two-letter cue would retrieve half the corpus. */
const MIN_CUE_LENGTH = 4;

/** Four is what fits on one row of a 340px column without wrapping into a
 *  block that competes with the list underneath it. */
const MAX_CUES = 4;

export interface Cue {
  /** The tag verbatim, as both the label and the query it runs. */
  text: string;
  /** How many memories in the corpus carry it, in any casing. */
  count: number;
}

export function corpusCues(memories: CorpusMemory[] | undefined): Cue[] {
  if (!memories || memories.length === 0) return [];

  // key: lower-cased tag → total mentions, and every surface form seen.
  const groups = new Map<string, { count: number; forms: Map<string, number> }>();

  for (const memory of memories) {
    for (const tag of memory.tags) {
      const trimmed = tag.trim();
      if (trimmed.length < MIN_CUE_LENGTH) continue;
      const key = trimmed.toLowerCase();
      const group = groups.get(key) ?? { count: 0, forms: new Map<string, number>() };
      group.count += 1;
      group.forms.set(trimmed, (group.forms.get(trimmed) ?? 0) + 1);
      groups.set(key, group);
    }
  }

  const cues: Cue[] = [];
  for (const group of groups.values()) {
    // The capitalised surface forms only. `[a-z]` is deliberately not the test:
    // an all-caps acronym is a name too.
    const named = [...group.forms.entries()].filter(([form]) => {
      const first = form[0];
      return first !== undefined && first !== first.toLowerCase();
    });
    if (named.length === 0) continue;

    // The form written most often wins; longer wins a tie, because the longer
    // form is the more specific one someone would recognise.
    named.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    cues.push({ text: named[0]![0], count: group.count });
  }

  // Most-mentioned first. Alphabetical within a tie so the row does not
  // reshuffle between renders of the same corpus.
  cues.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  return cues.slice(0, MAX_CUES);
}
