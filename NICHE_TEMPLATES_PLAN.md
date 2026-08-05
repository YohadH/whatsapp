# Niche Templates — Plan (v2, decisions locked)

**Goal:** at **self-serve signup** the owner picks their **niche**; HeyIL then seeds a
**deep, realistic** starter so they immediately *see and feel* how HeyIL works for
*their* business — tailored knowledge base, ready flows, message templates, business
hours, agent tone, **and the integrations/settings that actually matter for that niche**.

Decisions (locked): **self-serve signup** · niche pack **replaces** the generic demo ·
**very deep** content (customers must envision it working) · **per-niche tone** ·
**per-niche relevant integrations** (e.g. support→CRM, clinic→Calendar).

Everything seeded stays fully editable/deletable.

---

## 1. Niches (v2 — expanded)

| # | Niche (he) | Tone | **Must-have integration** | Also recommended |
|---|-----------|------|---------------------------|------------------|
| 1 | **עורכי דין** (lawyers) | Formal, discreet | Calendar (ייעוץ) | Webhook/CRM (תיוק פניות) |
| 2 | **קליניקות ומרפאות** (clinics) | Warm, caring | **Calendar (תורים)** | — |
| 3 | **חנות אונליין** (online store) | Friendly, sales | Webhook/CRM (הזמנות/לידים) | Zapier/Make |
| 4 | **חנות פיזית** (physical store) | Local, welcoming | Calendar (שריון/איסוף) | Webhook/CRM |
| 5 | **שירות לקוחות** (support) | Efficient, empathetic | **Webhook/CRM (פניות)** · *no calendar* | Zapier/Make |
| 6 | **מסעדות** (restaurants) | Hospitable | **Calendar (הזמנת מקום)** | Webhook/CRM |
| 7 | **נדל״ן** (real estate) | Professional, persuasive | **Webhook/CRM (לידים)** | Calendar (סיורים) |
| 8 | **יופי ומספרות** (beauty & barbers) | Friendly, personal | **Calendar (תורים)** | — |
| 9 | **כושר וסטודיו** (fitness/studios) | Motivating | **Calendar (שיעורים)** | Webhook/CRM |
| 10 | **בעלי מקצוע** (trades: שיפוצים/חשמל/אינסטלציה) | Reliable, practical | Calendar (ביקור בבית) | Webhook/CRM (לידים) |
| 11 | **אחר** (other) | Neutral | none forced | — |

---

## 2. What each niche seeds — DEEP (so the owner "gets it" instantly)

Every pack is rich, not a stub. Per niche it seeds:

- **Knowledge base — fully written** (not placeholders): business description, services
  & realistic prices, FAQ (6–10 Q&A), policies (ביטול/החזרים/סודיות as relevant),
  opening hours, contact — all in the niche's voice.
- **Agent tone** → `KnowledgeBase.customInstructions` (persona + do/don't for the vertical).
- **2–3 ready flows** matched to the niche (see §1) — the star flow wired to the niche's
  must-have integration (clinic booking → Calendar event; support ticket → CRM webhook).
- **Message templates** (curated, niche-specific) prefilled in דיוור.
- **Business hours** default for the vertical.
- **2 demo conversations** showing the agent handling a real scenario end-to-end
  (booking / lead / ticket) — tagged demo, hidden-from-inbox rules already apply — so the
  owner literally *sees* their agent working in their language before connecting anything.
- **Recommended integrations surfaced** (see §3).

> Content is authored per niche in a data file so we can keep making it deeper without
> code changes. I'll draft the full text for all 11 and you can edit any wording.

### Example depth — קליניקות ומרפאות (clinics)
- KB: תיאור, רשימת טיפולים + מחירים לדוגמה, הסדרים/ביטוחים, מדיניות ביטול 24ש׳, שעות.
- FAQ: "כמה עולה בדיקה ראשונית?", "האם יש חניה?", "מה מדיניות הביטול?", "האם מקבלים ביטוח X?", …
- Flows: **קביעת תור** (סוג טיפול · תאריך+שעה · שם · טלפון → **אירוע ביומן Google**) · שאלון טרום-טיפול.
- Templates: תזכורת תור 24ש׳ · הנחיות לאחר טיפול · מבצע עונתי.
- Demo convo: לקוח קובע תור מקצה-לקצה, הסוכן מאשר ומוסיף ליומן.
- Recommended: **חבר יומן Google** (must).

### Example depth — שירות לקוחות (support)
- KB: תקלות נפוצות + פתרונות, SLA/זמני מענה, מדיניות הסלמה, שעות.
- Flows: **פתיחת פנייה** (סוג · תיאור · מספר הזמנה · דרך יצירת קשר → **POST ל-CRM/Webhook**) · החזר/החלפה.
- Templates: אישור קבלת פנייה · מעקב פתרון · סקר שביעות רצון.
- Demo convo: לקוח מדווח תקלה, הסוכן פותח פנייה ומעביר ל-CRM. **אין יומן.**
- Recommended: **חבר Webhook/CRM** (must).

---

## 3. Per-niche relevant settings & integrations (your key requirement)

Each niche pack declares `integrations: { must: [...], recommended: [...], hide: [...] }`.
That drives, per niche:

1. **Onboarding "connect what matters" step** — right after picking the niche, we show
   the **must-have** integration prominently: clinics/beauty/fitness/restaurants →
   *"חבר יומן Google"*; support/real-estate/online-store → *"חבר את ה-CRM/Webhook שלך"*.
   The owner connects the ONE thing that matters, not a wall of options.
2. **Settings → אינטגרציות** — the niche's must/recommended integrations get a
   **"מומלץ לתחום שלך"** badge and sort to the top; irrelevant ones stay muted (e.g. a
   support account doesn't get Calendar pushed on it).
3. **The star flow is wired to that integration** — so connecting it makes the seeded
   flow actually *do* something (calendar event / CRM push) the moment it's on.

---

## 4. Build architecture

- **Data:** `backend/src/data/nichePacks.js` — one rich object per niche:
  `{ id, label, tone, kb{…}, businessHours, flows[], messageTemplateKeys[],
     demoConversations[], integrations:{must,recommended,hide} }`. Pure data.
- **Schema:** `Tenant.niche String?` (nullable, additive — migration 17).
- **Seeder:** generalize `services/trialSeed.js` → `seedNichePack(tenantId, niche)`
  (replaces the generic seed when a niche is chosen; `other` → today's generic).
  Keeps best-effort, per-block-guarded, idempotent behaviour + demo tagging.
- **Signup:** niche picker in the **self-serve flow** (register + onboarding step 1);
  `POST /api/auth/register` takes `niche` and seeds that pack.
- **Onboarding:** after niche → a "connect what matters" step showing the must-have
  integration; then the existing WhatsApp-connect step.
- **Integrations UI:** niche-aware ordering + "מומלץ לתחום שלך" badges (reads
  `Tenant.niche` → the pack's integration list).

---

## 5. Phasing

- **Phase 1:** nichePacks data (all 11, deep) · `Tenant.niche` + migration ·
  `seedNichePack` · niche picker in self-serve signup · apply-on-create (replace).
- **Phase 2:** onboarding "connect what matters" step + niche-aware Integrations badges.
- **Phase 3:** deepen content further per your edits; "switch niche" for existing accounts.

---

## Confirmed understanding (approve to build Phase 1)

- 11 niches incl. restaurants / real-estate / beauty / fitness / trades.
- Picked at **self-serve signup**; the pack **replaces** the generic demo.
- **Deep** authored content per niche (KB + FAQ + flows + templates + 2 demo convos + tone).
- **Per-niche integrations**: must-have surfaced in onboarding + badged in Settings; the
  star flow wired to it (clinic→Calendar, support→CRM, etc.); irrelevant ones not pushed.
- Seeded flows **off by default**; everything editable.
