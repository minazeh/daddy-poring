# Monster Quiz — bundled question banks

These three JSON files are the **authoritative, bundled** question banks for the
non-jumble Monster Quiz categories. They are small, static, and stored **verbatim**
as fetched (no reshaping). They are loaded from disk once at module init by
`../banks.js` and are **not** imported into MongoDB — the Hoppy / Guild Banquet /
Scholar categories run entirely offline (only the jumble category needs rodb).

## Provenance

Source: **roworlddb.com**, SEA server, `/sea/study` event-quiz data.
Locale token is lowercase-underscore **`en_us`** (NOT `en-US`).

| File | Category | Mode | Title | Questions |
|---|---|---|---|---|
| `lucky_rabbit_questions_en_us.json` | Hoppy Quiz | `truefalse` | Hoppy Quiz | 117 |
| `guild_banquet_questions_en_us.json` | Guild Banquet | `trivia` | Guild Banquet | 61 |
| `scholar_exam_questions_en_us.json` | Scholar Exam (Sage Quiz) | `trivia` | Scholar Exam | 270 |

## Shapes

Each file is a `{ eventId, title, questions:[...] }` object.

- **Hoppy** (`truefalse`): `{ id, question, answer:"True"|"False" }`
- **Guild Banquet** (`trivia`): `{ id, question, answers:[...] }` — `answers` may list
  several accepted forms (multilingual / synonyms); a guess wins if it matches ANY.
- **Scholar Exam** (`trivia`): `{ id, question, answer, questionTypeIds[], categoryIds[] }` —
  single `answer` string. `questionTypeIds` / `categoryIds` are **ignored** (no decode
  map is bundled); `banks.js`/`logic.toBankQuestion` wrap `answer` into a one-element
  `answers[]`.

## Refresh

To refresh, re-fetch each file to this directory (polite UA, a couple seconds apart):

```
https://roworlddb.com/sea/study/data/lucky_rabbit_questions_en_us.json
https://roworlddb.com/sea/study/data/guild_banquet_questions_en_us.json
https://roworlddb.com/sea/study/data/scholar_exam_questions_en_us.json
```

Store the raw JSON verbatim — the loader tolerates extra top-level fields and only
reads `.questions`. Last fetched: 2026-07-31.
