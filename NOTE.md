# Mini AI Voice KAM — one-page note

**What it is.** A browser voice assistant ("Priya") that acts as a Virtual Key Account Manager for a Snapdeal seller whose sales fell. It greets the seller, listens, diagnoses the drop from mock account data, asks follow-up questions, recommends 2–3 actions and closes with a spoken summary, a tracked action plan and a follow-up date.

**Stack**

| Layer | Choice | Why |
|---|---|---|
| Speech-to-text | Browser Web Speech API (`SpeechRecognition`, en-IN / hi-IN) | Streaming, no server, no cost |
| LLM | Gemini Flash (`gemini-3.8-flash`, automatic fallback to older Flash models) via REST `generateContent` with function calling, low thinking level | Fast enough for voice; reliable tool calls |
| Text-to-speech | Browser `speechSynthesis`, Indian English / Hindi voice, spoken sentence by sentence | Starts quickly, can be cut off instantly |
| Front end | Plain HTML/CSS/JavaScript, no framework or build step | Easy to run, read and explain |

**Workflow**

```
Mic → SpeechRecognition → seller turn (ends on ~1 s pause)
    → Gemini + system prompt + conversation history
        ↔ tool calls (JavaScript, deterministic) ↔ tool results
    → reply text → numbers to words → speechSynthesis → speaker
Seller speaks over the bot → voice stops, request cancelled, new turn starts
```

**How the agent works**

- *The LLM never does arithmetic.* It calls 16 tools in three groups: diagnosis (`get_account_overview`, `get_inventory_report`, `get_cancellation_report`, `get_pricing_and_visibility`, `get_sales_bridge`, `estimate_recovery`), stock practice (`get_product_movement`, `get_stock_plan`, `get_customer_enquiries`, `get_dispatch_report`) and actions (`log_seller_input`, `commit_action_plan`, `schedule_followup`, `send_summary`, `set_language`, `end_call`). The system prompt contains no figures; every number spoken comes from a tool result.
- *It leads.* After hearing the concern it pulls the account, opens with the headline finding and asks about it. It checks causes in order (inventory → cancellations → pricing and visibility → things outside the data) and says which are confirmed or ruled out.
- *It goes past "you ran out of stock".* It classifies fast and slow movers, sets min/max reorder levels from the supplier's lead time, warns about products about to run out, finds money locked in slow, ageing stock (sell oldest first), and ranks restocking by customer enquiries.
- *It commits.* The plan goes to an on-screen action tracker with owner, deadline and rupee impact; a follow-up call is booked and a WhatsApp summary is drafted (both simulated).
- *It checks itself.* A separate number check (`guard.js`) compares every figure in each reply with the numbers the tools returned and shows the result on screen, so a made-up figure is visible, not silent.
- *It can start the call.* Three monitoring rules run on the account. When one fires, the KAM makes an outbound call that opens with the reason.
- *Voice behaviour.* One to three sentences and one question per turn; interruption by speaking (barge-in) with an echo filter; "are you still there?" after silence; English or Hindi, switchable by asking.

**What the data says.** Sales −₹65,000 (−32.5%) with price flat at ₹500, so the drop is order volume. Estimated split: stockouts on 13 products ≈ ₹47,900, extra cancellations (8% → 14%) ≈ ₹9,400, not explained by data ≈ ₹7,700. Restocking the top three products and bringing cancellations back to 8% recovers about ₹39,600 a month. Deeper: 4 of 7 fast movers are sold out with 123 customers waiting, 2 more are about to run out, and about ₹1,10,300 sits in 4 slow products.

**Assumptions (all mock, listed in `js/data.js`)**

1. "Orders" are net of cancellations (270 × ₹500 = ₹1,35,000), so about 435 and 314 orders were placed.
2. 60 active products; 5 were already out of stock, 13 more ran out this month.
3. The 13 product names, prices, last-month units and days out of stock are invented. Lost sales = last month's daily rate × days out × price.
4. Cancellation reasons: 55% no stock, 25% late dispatch, 20% buyer changed mind.
5. Eight in-stock products, customer enquiries and dispatch times are invented. Fast = 20+ units a month. Min = daily sales × (lead time + 3 days); max = min + 15 days.
6. Store visits are invented and nearly flat (−4.1%). No competitor price data exists, so the agent asks the seller.

**Limits**

- The number check flags an unsupported figure but does not yet stop it being spoken. It reads digits, not numbers written as words.
- Turn-based, not full duplex: the Gemini Live API would give lower latency and a more natural voice.
- Browser voices vary by device. Barge-in works best with headphones.
- Works in Chrome and Edge on desktop; Firefox has no speech recognition.
- With a pasted key, the key sits in the browser tab. The included server proxy (`api/gemini.js`) keeps it server-side for a public link.
- A scripted backup flow runs if no key is present. It exists for testing the voice loop and is labelled on screen.

**What I would build next.** Real phone calls (Vapi or Twilio) with a streaming voice model; live seller data and write-back (pause sold-out listings, set alerts); outbound calls triggered when a seller's sales fall; more Indian languages; hand-off to a human KAM with the call summary.
