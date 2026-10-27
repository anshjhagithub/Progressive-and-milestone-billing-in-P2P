# DICE — Progressive & Milestone Billing prototype

Open `index.html` in a browser (no build, no server, no backend). The layout follows the real **DICE corporate portal**:
lilac sidebar group, underlined tabs, alternating-row tables, a stage tracker on every PO, and right-hand drawers for
*Create PO Order*, *GRN*, *SRN* and *Submit Invoice*. Amounts are in **INR** with **GST**.

All data lives in `localStorage`; **Scenarios & reset** (bottom of the sidebar) restores the seed.
Use **Acting as** (sidebar) to switch role — *Demo Admin* can do everything.

Flow: **PO → GRN (goods) / SRN (services) → milestone / progress → Invoice → Matching → Approval → AP**

## The one rule that keeps the flows consistent
A PO is either **Goods** or **Services**.

| | Goods PO | Services PO |
|---|---|---|
| Receipt document | **GRN** (delivered / rejected qty, inspection) | **SRN** (service value, acceptance) |
| Milestone gate ("needs an accepted …") | accepted **GRN** | accepted **SRN** |
| Progressive basis | accepted GRNs | accepted SRNs **or** certified work progress |

The gate follows the PO type everywhere — labels, buttons, validation and matching. A Goods PO can never ask for an SRN.

## What changed from the first prototype

**Logic fixes**
- Goods PO + milestones asked for an SRN that cannot exist on a goods PO → milestones now gate on a **GRN** (Services: **SRN**). You can create the receipt straight from the milestone drawer, or link an existing one. A receipt can back only one milestone; a reversed / pending / rejected receipt never clears the gate.
- Certified work progress is **Services only** and is tracked at PO level (the old claim form compared a per-line contract value with PO-wide certified totals).
- Receipts can only be created on **approved** POs of the matching type (GRN only on goods, SRN only on services).
- `Save PO` can no longer overwrite an approved PO (only drafts are editable; approved POs use **Amend PO**).
- Percentage schedules always add up to the PO value to the paisa (the last milestone absorbs rounding).
- GST is validated against the PO's own GST rate (it used to read the first line's tax code).
- Over-receipt, “partial milestone billing”, fixed-amount schedules and schedule “exceptions” are gone — milestones are billed once, in full.
- Only one open progress claim at a time; claims cannot exceed the PO value.
- One-step receipts: **Complete GRN / Complete SRN** accepts immediately; **Send for inspection / Submit for acceptance** leaves it pending. Pending quantities still reserve the PO quantity but are never invoice-eligible.

**UI**
- Re-skinned to the DICE portal (see above). Fewer screens: milestones, claims, receipts and invoices live inside the PO (tabs + drawers); the old Billing-Schedules, Matching and Dashboard-filter pages are folded into PO / Invoice / Overview.
- PO tabs: Overview · Line Items · Milestones / Progress Claims / Billing · GRN or SRN · Invoices · History. **What's next** tells you the next action on the PO.
- Removed options: payment terms, per-line codes / tax codes / locations, currency picker, approver / criteria / evidence-required fields, reorder arrows, finalize / unlock, “run matching on submit”, VAT override.

## Milestone lifecycle (current)
`Pending → In Progress → Submitted for Approval → Under Review → Approved` (or `Rejected → resubmit`)
1. **Start / Submit** — supplier (or receiver) starts the work and submits evidence with a completion date. If the milestone needs a document (e.g. *Commissioning Certificate*) the upload is mandatory.
2. **Review / Approve / Reject** — an approver reviews and decides; approving also approves the evidence document. The submitting role cannot decide (segregation of duties; Demo Admin is exempt). Every step is time-stamped in the audit trail.
3. **Acceptance conditions** (set per milestone, any combination): *document approval*, *accepted GRN(s)*, *accepted SRN(s)*. A GRN/SRN is never created to prove a certificate; a pending receipt blocks, a rejected/reversed one never counts.
4. **Invoice** — a milestone is billable only when *Approved* **and** every condition holds. Milestones that allow **partial invoicing** can be billed in parts up to the remaining balance; otherwise once, in full. Approved / invoiced-approved / reserved / remaining are shown separately. Cancelling or rejecting an invoice releases its reservation; a posted invoice is undone with **Reverse via credit note**.
5. **Milestone first** — from the milestone drawer you can *Create GRN / SRN for this milestone* (or link an existing one, several allowed) and then *Submit Invoice for this milestone*. The invoice drawer's *+ Add Line Item* works the other way round.
6. **Create PO** — each milestone takes an **amount or a percentage** (they update each other); PO types are Goods, Services and **Mixed** (GRN for goods lines, SRN for service lines).

## Round 2 — PRD alignment and DICE fidelity
- **Milestone approval is now visible everywhere**: an **Approve** button on the schedule row (Milestones tab), a **Your decision** card at the top of the milestone drawer (Approve / Request information / Reject), the drawer footer, the *What's next* card and the Approvals queue. A pending milestone shows **Mark complete** on its row.
- **PRD rules added**: segregation of duties (the role that submitted a milestone cannot approve / reject / query it — *Demo Admin* acts for every role so it is exempt; switch **Acting as** to test it) and the *Info Requested* outcome (vendor resubmits).
- **View GRN / View SRN** drawer (“All grn details”): PO number, GRN ID, items table, GRN amount / tax / total, delivery date, owner, remarks, attachments — plus the PRD's allocations and remaining eligible quantity. **Submit** / **OCR Invoice** open the invoice drawer with that receipt preselected (OCR is simulated).
- **View Invoice** drawer: invoice document on the left (vendor, invoice details, addresses, line items, financial summary with CGST/SGST/IGST) and tabs on the right — Format (matching checks as expandable rows, Three Way Match table, hold reasons, requested by, invoice details), Timeline, Settlement, CN, DN, PO, Holds. Open it with **View** on any invoice row.
- **PO screens**: GRN/SRN tab with *Pending … Items* / *Past … Items* and an *Invoices +* section; PO detail right column with Timeline (TAT, Export), Delegate Access, Support Ticket, PO copy to vendor; list toolbar (Filter · count · List View · Download Csv · Upload Csv · Manage Table View) — **Download Csv** exports the current list; Create-PO line items use the bordered DICE table with *Bulk Upload* and *Additional Attachment*.
- **Sidebar** shows the full DICE menu; entries outside this prototype show a short notice when clicked. The round button collapses the menu.

## Seeded POs (Scenarios & reset → Seeded demo)
| PO | Type · Billing | What it demonstrates |
|---|---|---|
| …/42 | Goods · Progressive | GRN-001/002/003 → 77 of 100 units eligible (INR 77,000) |
| …/43 | Goods · **Milestone** | M2 *Equipment Delivered* is approved but **blocked until GRN-001 is inspected** |
| …/44 | Goods · Standard | accepted GRN-001 (INR 24,000) + a GRN pending inspection |
| …/51 | Services · Progressive | accepted SRN-001, one invoice in approval and one with a GST mismatch |
| …/52 | Services · **Milestone** | M1 approved but SRN-001 pending → invoice blocked |
| …/60 | Services · Certified progress | PC-001 certified & invoiced; PC-002 awaiting certification (cum. 50,000 − 30,000 = 20,000) |
| …/61 | Goods · Standard | waiting for PO approval |

## Rules enforced (see `js/logic.js`)
- Eligibility: accepted GRN qty / accepted SRN value / approved milestone (+ accepted GRN or SRN where required) / certified claim. Pending, rejected and reversed quantities never qualify.
- Reservations: an invoice holds its allocation from *Submitted* to *Paid*; Rejected / Cancelled / Matching Failed / Draft hold nothing. First submit wins, the second is blocked.
- Approved, invoiced (reserved), paid and ready-to-invoice are separate measures everywhere.
- Credit / debit notes are separate adjustments and do not restore receipt quantities.
- PO amendments never rewrite history: prices lock once receipts / invoices exist, invoiced / approved milestones keep their amount.
- Posting and payment are simulated — nothing external is contacted.

## Files
| File | Purpose |
|---|---|
| `js/core.js` | helpers, INR / date formatting, icons, roles, persistence, audit |
| `js/logic.js` | **all rules**: balances, gates, matching engine, state transitions |
| `js/seed.js` | seed data + scenario loaders (`default`, `A`, `B`) |
| `js/ui.js` | router, drawers, modals, list engine, sidebar |
| `js/screens-po.js` | PO list, create / edit drawer, PO detail |
| `js/screens-receipts.js` | GRN / SRN drawers, receipt detail, receipts list |
| `js/screens-bill.js` | PO Billing tab: milestones (+ gate controls), claims, receipt allocation |
| `js/screens-inv.js` | invoice list, Submit Invoice drawer, invoice detail, approvals, AP |
| `js/screens-dash.js` | Overview |

---

# How to test

## Manual
1. Open `index.html`, then **Scenarios & reset → Reset demo data**.
2. Leave **Acting as** on *Demo Admin* (other roles disable buttons they don't own; hover to see why).

### Goods PO on milestones (the case that used to break)
1. Open **PO …/43 → Milestones**. M1 is *Eligible*; M2 shows `GRN-001 · Pending Inspection` and is *Not Eligible*.
2. Click M2 → the gate card shows the GRN. Open GRN-001 → **Accept all** (or **Record inspection** with some rejected units to see it stay blocked).
3. Back on M2: eligibility checklist is green → **Submit Invoice for M2**. The invoice drawer shows the live invoice preview and totals (base + 18% GST).
4. Try a second invoice for M2 → blocked ("only one invoice is allowed per milestone").

### Build a PO from scratch
1. **Purchase Order → Create Order**. Pick **Goods** or **Services**, vendor, title, line items, then a billing method. For *Milestone* tick "Needs an accepted GRN / SRN" on the milestones that need proof.
2. **Create Order** → open the PO → **Approve**.
3. Milestone drawer: **Mark complete & submit** (attach a sample file) → **Approve milestone**. Create the GRN / SRN from the same drawer and watch the gate clear.

### Progressive billing (PO …/42)
1. **Billing** tab → **Submit Invoice** → tick GRN-001, quantity 30 → submit. Expect Matched / Pending Approval, base 30,000 + GST 5,400.
2. A second invoice for GRN-001 is blocked; 25 units against GRN-002 (20 free after another invoice) shows the live message "Eligible: 20 units. Requested: 25 units."
3. **Approvals → Invoices** or the invoice page: **Approve → Post to AP → Mark as Paid**; check **Account Payables** and the PO overview bar (paid / approved / in approval / ready to invoice are separate).

### Other behaviours
| Test | Where | Expected |
|---|---|---|
| Standard billing | PO …/44 → Submit Invoice, 30,000 | blocked: accepted receipts are only 24,000 |
| SRN-gated milestone | PO …/52 → M1 → SRN-001 → Accept SRN | M1 becomes eligible; milestone approval itself unchanged |
| Certified progress | PO …/60 → Progress Claims → PC-002 → Certify | current claim 20,000; invoicing 50,000 blocked |
| Reversal | Accepted GRN → Reverse GRN | dependent invoices fail re-matching; a linked milestone loses its gate |
| Amend PO | PO …/43 → Amend PO | prices locked once receipts exist, invoiced milestones locked |
| Wrong type | Goods PO → GRN tab / Services PO → SRN tab | only the matching receipt can be created |

## Automated (needs Node and Chrome or Edge)
```
node tests/build-and-run.js                                  # ~110 logic checks, last line: ALL PASSED
powershell -File tests/run-browser.ps1 smoke.html            # every route / tab / drawer, last line: SMOKE PASSED
powershell -File tests/run-browser.ps1 flow.html             # clicks & typing through the drawers, last line: ALL UI FLOWS PASSED
powershell -File tests/shot.ps1 -Name x -Hash '#/pos'        # screenshot to %TEMP%\dice-shots (optional -Do '<js>' to open a drawer first)
```
`tests/shot.html` is the debug page behind `shot.ps1` (`shot.html?scn=B&do=<js>#/route`).

## Troubleshooting
- **Stale or odd data:** use **Scenarios & reset**, or clear this site's `localStorage` (the key is `dice.billing.proto.v2`).
- **A button is greyed out:** check **Acting as**, or the PO may not be Approved yet.
- **Fonts look different offline:** Inter loads from Google Fonts; the app falls back to system fonts.

## Edge cases covered (PRD v1.3 section 5)
`node tests/build-and-run.js` runs 232 scenario checks plus `tests/edge.test.js` (37 checks, one or more per edge case); `flow.html` drives the same through the UI.

| Case | Behaviour |
|---|---|
| E01-E04, E07, E08 | Accepted-only eligibility, pending reserves PO qty, one GRN in several invoices, one failing line blocks and is named, no over-receipt, price lock |
| E05, E10 | Posted / paid invoices are never altered; when their receipt is reversed they show an **AP review** flag with the overage (invoice list + invoice view) |
| E06 | Reversing a GRN **or SRN** re-matches every unposted dependent invoice at once (milestone, progressive and standard); failures drop to Matching Failed and release their hold |
| E09-E12 | Gates, one receipt per milestone, **Request info** (resubmit; both submissions kept), a receipt can no longer be linked to an already-invoiced milestone |
| E13 | Ageing on submitted milestones: reminder after 2 days, escalation to the Procurement Manager after 5 (Approvals tab + drawer) |
| E16 | Out-of-sequence approval is allowed with an advisory |
| E17 | Amounts typed instead of percentages sum exactly (no 99.9999% error) |
| E19 | **Cancel** an unsubmitted milestone through Amend PO; one with allocations / approval / linked receipts is refused with the reason; milestone codes never collide |
| E20 | Due-date changes never touch eligibility or amounts |
| E21 | **STALE**: if balances moved while the Submit Invoice drawer was open (also from another browser tab) the invoice is refused with the refreshed reasons |
| E22 | Idempotency key per submission - a double click returns the same invoice |
| E23 | Invoices stuck in Submitted / Pending Matching > 24 h become Matching Failed and release their hold (swept on load) |
| E24-E26 | Duplicate bill number fails matching; a rejected invoice's number can be reused on resubmission; credit notes never restore eligibility, **Reverse via credit note** (Posted / Paid) does |
| E27-E29 | Certified cumulative rules, amend below invoicing blocked, GST validated against the PO rate |

Not built (needs a backend or a product decision): E14 approver delegation, E30 advance / retention, true row-lock concurrency (E21 is detected at submit, not locked).

## Milestone billing specification (line-scoped schedules, gates, advances)
Implemented from *DICE Milestone Billing: Complete Specification*. The seeded **PO/FY26-27/09/47** is the worked example: a Mixed PO with a line-scoped schedule (200,000 · 4,000,000 · 600,000 · 200,000), a line billed outside the schedule, two shipments on one milestone, a 25 % advance against a verified guarantee and proportional recovery (invoice `DCB-2026-002` recovers 587,500; cash 2,079,750).

**Schedule (spec 4–5).** A milestone covers a *scope* of PO lines: a **quantity**, a **% of the line** or a **lump amount** per line. Its amount is *derived* from the scope, never typed (the simple "% of PO" form still works — it is a percent slice of every scheduled line). Coverage is checked per line: *"L2 has 5 of 20 Units not assigned to any milestone…"*, *"L3 is assigned 55 of 50 days. Reduce the scope on a milestone by 5 days."*, one basis per line, no scope on a line billed outside the schedule, a last slice that absorbs rounding. A coverage panel shows every line while you build the schedule. After approval, *Edit scope & gates* (unsubmitted milestones only) and *Add milestone* create a new PO version; reducing a line below its scope reopens the schedule until the difference is assigned.

**Gates (spec 6).** Document approval · accepted GRN / SRN · accepted quantity (quantity slices bill only the accepted units — staged deliveries need *partial invoicing*) · **complete quantity** (no part supply) · **bank guarantee verified by Finance** (an expired / rejected guarantee reopens the gate; an approved document can be withdrawn later). A receipt may back several milestones only when every link carries an explicit quantity; receipts must be for a line in the milestone's scope; no auto spill-over of a 7th server to the next slice. Optional **auto system SRN** on approval for service milestones (goods always need a real GRN). Dependencies are advisory unless the PO enforces them.

**Advances (spec 8).** Terms are set by the buyer per milestone (percent / fixed, proportional or first-invoice recovery, guarantee required) with caps (30 % per milestone, 20 % of the PO). The supplier requests (DICE-style *Create Advance* dialog: base, GST, TDS, total, payable), an approver other than the requester approves, Finance verifies the guarantee, the supplier raises the advance invoice (no receipt needed). Every later milestone invoice gets an automatic **negative recovery line**; the last invoice recovers the rest; both GST modes (*taxed on advance*, *taxed at final*) reproduce the specification's ledger. Outstanding O = P − R − F counts on the PO ceiling (I + O), a posted advance invoice cannot be undone while later invoices recovered it, only a **refund** (not a credit note) reduces an advance, and a milestone with an outstanding advance cannot be cancelled.

**Multi-line invoice intake (spec 7.5).** *Submit Invoice → Match supplier lines…* matches each supplier line to a PO line and milestone and checks it in order — PO match → duplicate → rate (with tolerance) → milestone state → remaining on the slice → tax → PO ceiling — and groups the result as **Billable / Waiting / Reject** with a reason, overrides per line, a generated return message, and *Use billable lines*.

**Reports and controls.** Billing Overview shows outstanding advances by age, guarantees expiring within 30 days and AP review items, plus settings (reminder / escalation days, reservation timeout, admin exemption from segregation of duties) and **delegation of approvals**. New roles: Project Owner (approves milestones and advances) and Finance Officer (verifies guarantees). Dates are sanity-checked (no future bill / receipt / completion dates, none before the PO date); an advance guarantee must cover the advance.

**Tests.** `node tests/build-and-run.js` — 232 scenario checks, `tests/edge.test.js` (37, PRD v1.3 §5), `tests/spec.test.js` (118, this specification incl. the full 8.6 ledger in both GST modes); `tests/flow.html` drives the scoped schedule → advance → recovery flow through the UI.

Not built: notifications, a concurrency harness (the prototype is single-user; stale balances are detected at submit), retention.

## Dependencies & timing (brief cases 1–3, D01–D06, D10–D11, D18–D20)
Each dependency does one of three separate things — **Schedule** (derives a date), **Gate** (blocks) or **Both**. A late planned date never blocks billing by itself.
- **Relations:** Finish→Start, Start→Start, Finish→Finish, each with a lag in days (negative = overlap). A gate acts on *billing* (FS), *starting* (SS) or *approval* (FF), on the predecessor being approved, invoiced or paid. Several gates join as **All** or **Any**.
- **Dates:** a milestone has a due date (finish), a duration (start = finish − duration) and an optional forecast. Resolution is planned → forecast (own or derived from predecessors) → actual (approval date). Moving a predecessor moves its dependents' forecasts; the editor and the amendment audit show the impact, and invoiced milestones are never recomputed.
- **Controls:** dependency cycles block the save; a successor dated before its predecessor is a warning; an invoiced milestone's due date, duration and dependencies are frozen; a cancelled predecessor leaves its dependents held until re-pointed; one milestone can be the **closing** milestone (approved only after all others and all receipts are complete).
- **Invoice due:** later of receipt and acceptance (or either alone) + days, set per PO (default by category); the Submit Invoice drawer fills it in and leaves a typed date alone.
- **UI:** the milestone editor is four short sections; the schedule table has Timeline / Amount / Status columns, a timeline chart and dependency chips; the milestone drawer has a *Timing & dependencies* card and *Edit timing & dependencies* (allowed after approval, until invoiced).
- Tests: `tests/deps.test.js` (42 checks, run by `node tests/build-and-run.js`) and the dependency flow in `tests/flow.html`.
- Not built from the brief: deemed acceptance (D07–D08), invoice window (D09), rejection reason codes (D12), damages (D13), extension of time (D14), clock pauses (D15), and the invoice-linking / GRN-SRN groups I01–I20, G01–G13.

### Brief cases 2 and 3
- **Case 3 — cumulative quantity trigger.** *Conditions to invoice → Fire on cumulative accepted quantity*: a goods line and a threshold. The milestone becomes eligible when every accepted GRN of that line adds up to the threshold (it fires on the GRN that crosses it; reversing that GRN reopens it). The milestone's quantity scope still decides what it bills; on such a line accepted units are pooled and served to the quantity slices in schedule order, so surplus units count toward the next slice (115 received → M1 bills 100, M2 is eligible for 15).
- **Case 2 — duration, follow-on, due date, damages.** Duration + finish-to-start dependency + invoice due (see above), plus **delay damages** per milestone: a rate per week or part late and a cap (% of the milestone value). Lateness = reported completion date vs the (possibly extended) due date; the invoice shows a negative *Delay damages* line deducted from the payable (GST unchanged) and a due-date extension by amendment recomputes it (the original date is kept).
- Tests: `tests/deps.test.js` (57 checks) and the UI flows in `tests/flow.html`.

## Invoice linking (brief I01–I18)
Wording: what the app used to call a *slice* is now a **portion** — the part of one PO line (a quantity, a % or an amount) that a milestone covers.
- **Lines:** a supplier invoice line can carry quantity, rate, unit and tax rate. Rate differing from the PO line (beyond the PO tolerance) is blocked (I11); a different unit converts with the PO line's factor, none = blocked (I13; set *Unit conversions* on the PO, e.g. `Box=10`); each line's tax rate must match its PO line, mixed rates are allowed and the header GST is the sum of the lines (I14; set a per-line GST on the PO); quantity above the accepted, unbilled quantity is blocked and the accepted quantity is shown (I09).
- **Allocation trace (I05–I07):** each milestone allocation is traced to the receipt lines it consumed — oldest acceptance first, a part-used receipt keeps the rest eligible, an override order is honoured before submission, and the trace is locked once the invoice is submitted. Shown on the invoice page.
- **Several milestones on one invoice (I02):** every allocation must pass; the due date is worked out per milestone and the invoice carries the earliest (the invoice page shows the split).
- **I01, I03, I04, I08, I10:** full billing unless partial billing is on; several invoices only within the remaining balance; one PO line across two milestones billed as separate lines; quantity and amount-only portions together; nothing before eligibility.
- **Fixed vs measured (I15):** a service milestone can be *Measured* — the invoice cannot exceed the accepted SRN value; otherwise the agreed amount is billed and the SRN is evidence.
- **Notes (I17, I18):** a credit note reduces the payable and never restores eligibility (only a reversal does); a debit note on a milestone invoice needs an approved PO amendment (enter its version) and can never take the milestone above its amount.
- Tests: `tests/link.test.js` (27 checks) and the *full journey* flow in `tests/flow.html` (create PO → milestones → GRNs → approve → invoice → approve → pay).
