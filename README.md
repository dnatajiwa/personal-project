# Growth Hub — Personal Development App

A lightweight, private web app to track three personal goals:

1. **Learn Mandarin** — HSK 1 flashcards (90 words) with spaced repetition, audio pronunciation (browser text-to-speech), a daily phrase for shadowing, and a practice-time log.
2. **Reduce weight** — weigh-in log, trend chart with 7-entry average and goal line, BMI, weekly rate of change, progress to goal, and a daily healthy-habits checklist.
3. **Learn AI Governance & Architecture** — a 12-module curriculum (NIST AI RMF, EU AI Act, ISO/IEC 42001, operational governance, RAG, agents, evals, LLMOps, AI security) with curated official resources, per-module notes, a study-time log, and a self-check quiz.

The **Today** dashboard combines all three: a daily plan, streaks per goal, and a 12-week activity heatmap.

## Run it

No install or build step. Either:

- open `index.html` directly in a browser, or
- serve the folder: `python3 -m http.server 8000` then visit http://localhost:8000

It works on desktop and phone (bottom tab bar on small screens). To use it on your phone, host the folder with GitHub Pages (Settings → Pages → deploy from branch).

## Your data

Everything is stored in your browser's `localStorage` — nothing is sent anywhere. Use **Settings → Export backup** regularly, and **Import backup** to move to another device or browser.

## Tips

- **Flashcards:** press `Space` to reveal, then `1` Again, `2` Good, `3` Easy. Cards move up review "boxes" (1, 3, 7, 14, 30, 60 days).
- **Weight:** weigh in at the same time each morning; trust the 7-day average more than single days.
- **AI:** work through modules in order, write notes in your own words, then retake the quiz.

## Project structure

```
index.html        App shell and navigation
css/styles.css    Styles (light & dark mode, responsive)
js/data.js        Content: HSK 1 vocab, phrases, AI curriculum, quiz
js/app.js         App logic: views, spaced repetition, tracking, storage
```

To add vocabulary, modules or quiz questions, edit `js/data.js`.
