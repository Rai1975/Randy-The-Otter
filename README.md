# Randy The Otter

**A pixel otter who lives at the edge of your browser and keeps you company through the job hunt.**

Built for [SASEhack 2026](https://sasehack-2026.devpost.com).

Searching for a job means a great many tabs, a great many forms, and long
stretches of quiet in between. The tools built for it are capable, but they
treat the whole process as data entry — spreadsheets, dashboards, and status
columns. They help you keep records. They do not make the day any brighter.

Randy takes a different approach. He peeks in from the right-hand edge of
LinkedIn, Handshake and Greenhouse, pays attention to whatever posting you are
reading, and every so often offers his honest read on it — usually a nudge in
the right direction:

> yeahhh this is kinda your lane

and now and then something rather more pointed, when a posting has earned it:

> bro this is three jobs wearing a trench coat

Either way it is a real signal about a real listing. And when there is proper
work to be done, he rolls up his sleeves and does it.

---

## What he does

Hover over Randy and a chevron appears. Click it, and three actions unfold.

| | |
|---|---|
| **Match** | Weighs the posting against your actual experience and explains the verdict. `"7/10 — solid backend fit, you'd learn the infra fast"` |
| **Track** | Every application you confirm, recorded with company, title, date and status. |
| **Tailor** | A cover letter or résumé, written from your profile and this particular posting, compiled to PDF and downloaded for you. |

Alongside all of that, he is simply around:

- **He notices things himself.** Spend a moment on a posting and he will offer a thought, unprompted — usually encouraging, occasionally a roast. No button required.
- **He remembers to ask.** Move on from a job and he checks whether you applied, then records it. The tracker fills itself in as you go.
- **He is an otter, not a widget.** He hops out onto a log when you call him, leans out to speak, grows charmingly indignant if you poke him five times, and slips back behind the edge of the screen once you are busy again.

## Why it's different

Most tools in this space are something you open, fill in, and close again.
What they cannot do is simply *be present* — living on the page, aware of the
search as a whole rather than one posting at a time. That is the idea Randy
explores: the job-hunt companion people keep installed is the one with a face,
a bit of warmth, and opinions worth hearing.

---

## How it works

```text
Chrome extension (MV3)                 Flask backend
┌──────────────────────────┐          ┌─────────────────────────────┐
│ content scripts          │          │ orchestrator (Strands)      │
│  · sprite state machine  │  HTTP    │  ├─ roast specialist        │
│  · scrapers  ───────────────────────▶  ├─ match-score specialist  │
│  · action menu           │          │  ├─ cover-letter specialist │
│ service worker           │          │  └─ résumé specialist       │
│  · downloads, tabs       │          │        │                    │
└──────────────────────────┘          │        ▼  LaTeX → PDF       │
                                      └────────┼────────────────────┘
                                               ▼
                                   Tectonic compile service (Docker)
```

**Extension.** Manifest V3, with content scripts running on LinkedIn,
Handshake and Greenhouse. Randy himself is a small state machine — pose ×
mood × speaking, with one-shot transitions for his jumps and his sulks —
driving 22 hand-drawn animations at 48 pixels. His speech bubble types itself
out in time with his mouth, and every element arrives and departs through a
stepped pixel dissolve generated at build time.

**Reading the page.** LinkedIn is read straight from the DOM. Handshake
renders its listings client-side, so a page-context interceptor captures the
GraphQL responses and merges them with the DOM scrape — either source on its
own leaves gaps.

**Agents.** A session-scoped orchestrator delegates to stateless specialists
via the agents-as-tools pattern (Strands + Gemini). Cover letter and résumé
bypass the orchestrator and call their specialist directly, because an extra
agent hop loses the invocation state the PDF handoff depends on.

**Deployment.** The backend runs on Railway and the extension is built with
that URL baked into `src/config.js`, so a downloaded copy works without any
local setup. Build without `BACKEND_CLOUD_URL` set and it falls back to
`127.0.0.1:5000` instead. The download page is a static build on Vercel.

**Documents.** The agent fills a LaTeX template from your profile, and a
containerised Tectonic service compiles it. Generation runs as a job: the
`POST` returns a `job_id`, the service worker polls for status, and the
finished PDF arrives quietly in your downloads.

---

## Getting Randy

The quickest way is to download him — no Python, no API keys, nothing to run.
The extension ships pointing at our hosted backend, so it works on its own.

**→ [randy-the-otter.vercel.app](https://randy-the-otter.vercel.app/)**

1. **Download** the extension from the site and extract the ZIP somewhere sensible.
2. Open **`chrome://extensions`** in Chrome.
3. Turn on **Developer mode** — the toggle sits in the upper right.
4. Choose **Load unpacked** and select the folder you extracted.
5. Open Randy's **settings** and add your preferences and details. Tailor asks
   for these before it writes anything, so it is worth doing first.
6. **Refresh** any LinkedIn, Handshake or Greenhouse tab you already had open.

> That last step matters more than it sounds. Reloading an extension leaves
> content scripts stranded in tabs that were already open, so do give the page
> a refresh — otherwise Randy will not answer.

Your details and preferences live in Chrome's extension storage on your own
machine. Randy fills forms in as a first draft, so do read anything he has
written before you send an application off.

---

## Layout

```text
extenstion/          Chrome extension (MV3)
  src/content/         Randy, speech bubble, action menu
  src/scrapers/        LinkedIn, Handshake, Greenhouse
  src/background/      service worker — downloads, tabs
  src/settings/        preferences page
  src/applications/    application tracker
  src/assets/          22 sprite animations + pixel font
  tools/               sprite + dissolve-mask generators
backend/
  agents/              orchestrator and four specialists
  tools/               LaTeX templates, PDF pipeline, profile access
  tests/               tracker and session-handoff tests
latex_service/         containerized Tectonic compile service
site/                  public download page (Vercel)
scripts/               build — packages the extension ZIP the site serves
```

## Built with

Chrome Extensions MV3 · Flask · Strands Agents · Google Gemini · LaTeX /
Tectonic · FastAPI · Docker · Railway · Vercel

---

*Randy is an otter, not a careers adviser — but he means well, and he is
always pleased to see you. Take the roasts in the spirit they are offered.*
