# Virtual KAM

A voice-first AI Key Account Manager for marketplace sellers, built as a prototype for the Snapdeal AI First Intern assignment.

The seller speaks, the assistant listens, checks the seller's account through tool calls, asks follow-up questions, recommends actions, and closes the call with a summary and a follow-up date.

**Live demo:** `ADD YOUR VERCEL LINK HERE`

> Prototype on mock data. It is not connected to any Snapdeal system and is not an official Snapdeal product.

## What it does

- **Two-way voice call** in the browser, in English or Hindi. The seller can interrupt by speaking.
- **Diagnoses a sales drop** by checking inventory, cancellations, pricing and visibility, in that order.
- **Checks day-to-day stock practice:** fast and slow movers, min/max reorder levels, ageing stock (FIFO), customer enquiries and dispatch speed.
- **Commits to next steps:** an action plan with owner, deadline and expected impact, a follow-up call date, and a WhatsApp summary (both simulated).
- **Verifies its own numbers:** every figure spoken is compared with the data the tools returned, and the result is shown under each reply.
- **Can start the call itself:** when a monitoring rule fires on the account, the KAM makes an outbound call that opens with the reason.
- **Reports on the call:** live reply times and counts, plus a downloadable call report.

## How to open it

**Online:** open the live demo link above in Google Chrome or Microsoft Edge on a computer, click **Seller calls KAM**, and allow the microphone.

**On your own machine:**

1. Get a Gemini API key from https://aistudio.google.com/apikey
2. Start a local server in this folder:
   ```
   python -m http.server 8000
   ```
   (or open the folder in VS Code and use the Live Server extension)
3. Open http://localhost:8000 in Chrome or Edge.
4. Click **Settings**, paste the key, click **Done**.
5. Click **Seller calls KAM**, allow the microphone, and speak.

Notes:

- Use Chrome or Edge on a desktop. Brave and Firefox do not support browser speech recognition.
- Open it through a server address, not by double-clicking `index.html`.
- Headphones give the cleanest interruptions.
- Without an API key the app runs a labelled scripted backup flow. With a key, Gemini drives the conversation.

## How to use it

1. Click **Seller calls KAM** and wait for the greeting.
2. Speak as the seller, for example: "My sales have dropped significantly this month. I don't understand why. Can you help me?"
3. Answer the KAM's questions. The panels on the right fill in as it works.
4. When the call ends, click **Download call report**.

The switch in the header changes what is shown. **Seller view** shows only the call, as a seller would experience it. **Agent view** adds the panels that show what the agent is checking and doing. The agent behaves the same in both.

**KAM calls seller** starts the proactive version of the call. The language can be changed from the dropdown, or by asking during the call.

## How it works

```
Microphone → speech-to-text → Gemini (system prompt + conversation history)
                                  ↕ tool calls / tool results (JavaScript)
           → reply text → numbers to words → text-to-speech → speaker
```

| Layer | Technology |
|---|---|
| Speech-to-text | Browser Web Speech API (`SpeechRecognition`) |
| Language model | Google Gemini Flash, REST `generateContent` with function calling |
| Text-to-speech | Browser `speechSynthesis` |
| Front end | HTML, CSS and JavaScript, no framework or build step |
| Hosting | Static files, with an optional serverless function that keeps the API key on the server |

The model never does arithmetic. It calls 16 JavaScript tools that compute every figure from the data, and it only explains the results.

## Project structure

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Page and styling |
| `js/data.js` | Mock data: the five metrics from the brief plus labelled assumptions |
| `js/tools.js` | The agent's tools and the monitoring rules; all calculations |
| `js/prompt.js` | System prompt and tool declarations sent to Gemini |
| `js/speech.js` | Speech-to-text, text-to-speech, numbers to spoken words |
| `js/guard.js` | Number check on every reply |
| `js/brain.js` | Gemini tool-calling loop, retries, model fallback, scripted backup |
| `js/app.js` | Call flow, interruption, silence handling, panels, call report |
| `api/gemini.js` | Serverless proxy that holds the API key (used on Vercel) |
| `tests/` | Unit and browser tests |
| `NOTE.md` | One-page project note |

## Deployment

The live demo runs on Vercel. The Gemini API key is stored as the `GEMINI_API_KEY` environment variable and used only by `api/gemini.js`, so it is never sent to the browser.

## Mock data and assumptions

The five metrics given in the brief are used as stated: sales, orders, cancellation rate, average selling price and out-of-stock products, for last month and this month. Everything else is invented for the prototype and listed in `js/data.js` under `ASSUMPTIONS`, including the product list, cancellation reasons, customer enquiries, dispatch times and store visits.

## Limitations

- Runs in a browser tab; it is not a phone call.
- Speech and reasoning are separate steps, so replies are slower than a streaming voice model.
- Voice quality depends on the voices installed in the browser.
- The number check flags an unsupported figure but does not stop it being spoken.
- The follow-up call and WhatsApp message are simulated.

## Tests

```
node tests/unit.js
node tests/e2e.js     # needs Playwright and a local server on port 8765
```
