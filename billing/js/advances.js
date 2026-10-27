/* =====================================================================
   advances.js — guarantees, advances against a milestone (request → approval → invoice → recovery → refund),
   PO consumption (I + O), multi-line invoice intake, reports. No DOM access.
   An advance is part of a milestone's value paid early and recovered from the invoices that later bill that milestone — never extra money.
   For a milestone of amount A, invoiced net I, advance paid P, recovered R and refunded F:  O = P − R − F  ·  I + O ≤ A  ·  PO consumption = Σ I + Σ O
   ===================================================================== */
const poCfg = po => ({ ...PO_DEFAULTS, ...((po && po.settings) || {}) });
const advList = () => (db.advances || (db.advances = []));
const getAdv = id => advList().find(a => a.id === id);
const advsOf = po => advList().filter(a => a.poId === po.id);
const advOfMs = m => advList().filter(a => a.msId === m.id && !a.rejected);
const advInvoiceOf = a => a.invoiceId ? getInv(a.invoiceId) : null;
const advLiveInv = (a, exInv) => { const i = advInvoiceOf(a); return i && isLive(i) && i.id !== exInv ? i : null; };
const advP = (a, exInv) => { const i = advLiveInv(a, exInv); return i ? i.net : 0; };
const advR = (a, exInv) => sum(db.invoices.filter(i => i.id !== exInv && isLive(i) && i.recovery && i.recovery.items), i => sum(i.recovery.items.filter(x => x.advId === a.id), x => x.net));
const advO = (a, exInv) => r2(Math.max(0, advP(a, exInv) - advR(a, exInv) - (a.refunded || 0)));
const advTermAmount = m => { const t = m && m.advance; if (!t || !t.allowed) return 0; return r2(t.mode === 'amount' ? +t.value : m.amount * (+t.value) / 100); };
const advOutstandingOf = po => sum(advsOf(po), a => advO(a));
/* PO consumption for the ceiling: invoiced net of every live non-advance invoice + unrecovered advance, so an advance is never counted twice */
const poConsumed = (po, exId) => r2(sum(db.invoices.filter(i => i.poId === po.id && isLive(i) && i.id !== exId && !i.advanceId), i => i.net) + sum(advsOf(po), a => advO(a, exId)));
const recoveryCash = i => i && i.recovery ? r2((i.recovery.net || 0) + (i.recovery.gst || 0)) : 0;

function advStatus(a) {
  if (a.rejected) return 'Rejected';
  const inv = advInvoiceOf(a);
  if (inv && isLive(inv)) {
    if (inv.status !== 'Paid') return 'Invoice raised';
    const R = advR(a), F = a.refunded || 0, O = advO(a);
    if (R > EPS) return O <= EPS ? 'Recovered' : 'Partly recovered';
    if (F > EPS) return O <= EPS ? 'Refunded' : 'Partly recovered';
    return 'Paid';
  }
  if (!a.approved) return 'Requested';
  if (a.guaranteeRequired && gState(a.guarantee) !== 'Verified') return 'Guarantee pending';
  return 'Approved';
}
const ADV_OPEN = a => !['Recovered', 'Refunded', 'Rejected'].includes(advStatus(a));

/* ---------- guarantees (milestone gate and advance gate) ---------- */
const gState = g => !g || !(g.files || []).length ? 'Not Uploaded' : (g.status === 'Verified' && g.validUntil && g.validUntil < todayISO()) ? 'Expired' : g.status;       // Not Uploaded | Uploaded | Verified | Rejected | Expired
function guaranteeCond(g, title) {
  const st = gState(g);
  return { key: 'guarantee', ok: st === 'Verified', status: st, title, recs: [],
    reason: st === 'Verified' ? '' : st === 'Not Uploaded' ? `the ${title} has not been uploaded yet` : st === 'Uploaded' ? `the ${title} is uploaded and awaiting Finance verification` : st === 'Expired' ? `the ${title} expired on ${fmtD(g.validUntil)} — upload a valid guarantee` : `the ${title} was rejected${g.rejectReason ? ' (' + g.rejectReason + ')' : ''} — upload a corrected guarantee` };
}
function putGuarantee(holder, title, d, ref, poId) {
  const errs = [], files = d.files || [];
  if (!String(d.bank || '').trim()) errs.push('Enter the issuing bank.');
  if (!(+d.amount > 0)) errs.push('Enter the guarantee amount.');
  if (!d.validUntil) errs.push('Enter the validity date.'); else if (d.validUntil < todayISO()) errs.push(`The guarantee is already expired (valid until ${fmtD(d.validUntil)}).`);
  if (!files.length) errs.push(`Attach the ${title}.`);
  if (errs.length) return NO(errs);
  const prev = holder.guarantee, v = (prev ? prev.version : 0) + 1;
  holder.guarantee = { id: uid('gu'), title, bank: String(d.bank).trim(), amount: r2(+d.amount), validUntil: d.validUntil, files: [...files], status: 'Uploaded', version: v, uploadedBy: actor(), uploadedRole: db.meta.role, uploadedAt: nowISO(), verifiedBy: '', verifiedAt: '', rejectReason: '', history: [...(prev ? prev.history : []), { at: nowISO(), by: actor(), action: 'Uploaded', note: `v${v}` }] };
  audit(poId, ref, `${title} uploaded (v${v}): ${holder.guarantee.bank}, ${money(holder.guarantee.amount)}, valid until ${fmtD(holder.guarantee.validUntil)}.`, 'ms');
  save(); return OK(`${title} uploaded — awaiting Finance verification`);
}
function decideGuarantee(holder, ok, reason, ref, poId) {
  const g = holder.guarantee;
  if (!g || !(g.files || []).length) return NO('Nothing to verify — the guarantee has not been uploaded.');
  if (g.status !== 'Uploaded' && !(ok === false && g.status === 'Verified')) return NO(`The guarantee is ${gState(g).toLowerCase()} — there is nothing awaiting verification.`);
  if ((db.meta.role !== 'admin' || !cfg().adminExemptFromSod) && g.uploadedRole === db.meta.role) return NO('Segregation of duties: the same role cannot upload and verify a guarantee.');
  if (!ok && !String(reason || '').trim()) return NO('A reason is required.');
  Object.assign(g, ok ? { status: 'Verified', verifiedBy: actor(), verifiedAt: nowISO(), rejectReason: '' } : { status: 'Rejected', verifiedBy: actor(), verifiedAt: nowISO(), rejectReason: reason });
  g.history.push({ at: nowISO(), by: actor(), action: ok ? 'Verified' : 'Rejected', note: reason || '' });
  audit(poId, ref, `${g.title} ${ok ? 'verified' : 'rejected: ' + reason} by Finance.`, ok ? 'ok' : 'bad');
  return null;
}
A.msUploadGuarantee = (msId, d) => { const { m, po } = msCtx(msId); if (!m) return NO('Milestone not found.'); if (!m.needsGuarantee) return NO(`${m.code} does not require a guarantee.`); if (po.status !== 'Approved') return NO('The PO must be approved first.'); return putGuarantee(m, m.guaranteeTitle, d, msRef(po, m), po.id); };
A.msVerifyGuarantee = id => { const { m, po } = msCtx(id); if (!m) return NO('Milestone not found.'); const e = decideGuarantee(m, true, '', msRef(po, m), po.id); if (e) return e; const failed = revalidateDependents(po, 'milestone', m.id, 'guarantee verified'); save(); return OK(`${m.guaranteeTitle} verified`); };
A.msRejectGuarantee = (id, reason) => { const { m, po } = msCtx(id); if (!m) return NO('Milestone not found.'); const e = decideGuarantee(m, false, reason, msRef(po, m), po.id); if (e) return e; const failed = revalidateGate(po, m, 'guarantee rejected'); save(); return OK(`${m.guaranteeTitle} rejected${failed.length ? ` — ${failed.length} invoice(s) failed re-matching` : ''}`); };
/* an approved document later found wrong: the gate reopens exactly like a reversed receipt (spec 6.4) */
A.msRevokeDoc = (id, reason) => {
  const { m, po } = msCtx(id); if (!m || !m.needsDoc || !m.doc || m.doc.status !== 'Approved') return NO('Only an approved document can be withdrawn.');
  if (!String(reason || '').trim()) return NO('A reason is required.');
  Object.assign(m.doc, { status: 'Rejected', rejectReason: reason, decidedBy: actor(), decidedAt: nowISO() });
  const failed = revalidateGate(po, m, `${docTitleOf(m)} withdrawn`);
  audit(po.id, msRef(po, m), `${docTitleOf(m)} approval withdrawn: ${reason}. The gate reopens — no new invoices until a corrected document is approved.${failed.length ? ` Unposted invoices ${failed.map(invRef).join(', ')} failed re-matching.` : ''}`, 'bad'); save();
  return OK(`${docTitleOf(m)} withdrawn${failed.length ? ` — ${failed.length} invoice(s) failed re-matching` : ''}`);
};
function revalidateGate(po, m, why) { return revalidateDependents(po, 'milestone', m.id, why); }
/* guarantees past their validity date reopen the gate: unposted invoices that relied on them are re-matched */
A.expireGuarantees = () => {
  let n = 0;
  db.milestones.forEach(m => { if (m.needsGuarantee && gState(m.guarantee) === 'Expired' && !m.guarantee.expiryNoted) { m.guarantee.expiryNoted = true; const po = getPO(m.poId); audit(po.id, msRef(po, m), `${m.guaranteeTitle} expired on ${fmtD(m.guarantee.validUntil)} — ${m.code} is Not Eligible until a valid guarantee is verified.`, 'bad'); revalidateGate(po, m, 'guarantee expired'); n++; } });
  if (n) save(); return n;
};
A.sweep = () => A.expireStaleInvoices() + A.expireGuarantees();

/* ---------- advance terms (buyer, locked with the schedule) ---------- */
function advanceTermErrors(d, amounts) {
  const errs = [], c = { ...PO_DEFAULTS, ...(d.settings || {}) }, ms = d.milestones || []; let total = 0;
  ms.forEach((m, i) => { const t = m.advance; if (!t || !t.allowed) return; const code = m.code || `M${i + 1}`, A = amounts[i] || m.amount || 0;
    if (!(+t.value > 0)) { errs.push(`${code}: enter the advance value.`); return; }
    const adv = t.mode === 'amount' ? +t.value : A * (+t.value) / 100, cap = A * c.maxAdvancePctPerMilestone / 100;
    if (adv > cap + EPS) errs.push(`Advance of ${money(adv)} exceeds the ${c.maxAdvancePctPerMilestone}% cap (${money(cap)}) on ${code}.`);
    if (t.guaranteeRequired && !String(t.guaranteeTitle || '').trim()) errs.push(`${code}: name the advance guarantee (e.g. Advance payment guarantee).`);
    total += adv; });
  const sched = sum(amounts, x => x), poCap = sched * c.maxAdvancePctOfPO / 100;
  if (total > poCap + EPS) errs.push(`Advances of ${money(total)} across all milestones exceed the ${c.maxAdvancePctOfPO}% PO cap (${money(poCap)}) on the scheduled value ${money(sched)}.`);
  return errs;
}

/* ---------- advance lifecycle ---------- */
const TDS_RATES = [0, 1, 2, 5, 10];
function advCapErrors(po, m, base, exAdv) {
  const c = poCfg(po), errs = [], perCap = r2(m.amount * c.maxAdvancePctPerMilestone / 100), term = advTermAmount(m);
  if (base > perCap + EPS) errs.push(`Advance of ${money(base)} exceeds the ${c.maxAdvancePctPerMilestone}% cap (${money(perCap)}) on ${m.code}.`);
  else if (base > term + EPS) errs.push(`Advance of ${money(base)} exceeds the agreed advance terms (${money(term)}) on ${m.code}.`);
  const sched = sum(msOf(po), x => x.amount), poCap = r2(sched * c.maxAdvancePctOfPO / 100), existing = sum(advsOf(po).filter(a => !a.rejected && a.id !== (exAdv && exAdv.id) && advStatus(a) !== 'Refunded'), a => a.base);
  if (r2(existing + base) > poCap + EPS) errs.push(`Total advances of ${money(existing + base)} would exceed the ${c.maxAdvancePctOfPO}% PO cap (${money(poCap)}). Advances already requested or approved: ${money(existing)}.`);
  const I = usage('milestone', m.id).value, O = sum(advOfMs(m).filter(a => !exAdv || a.id !== exAdv.id), a => advO(a));
  if (r2(I + O + base) > m.amount + EPS) errs.push(`${m.code}: invoiced ${money(I)} plus advances ${money(O + base)} would exceed the milestone amount ${money(m.amount)}.`);
  return errs;
}
A.requestAdvance = d => {
  const po = getPO(d.poId), m = getMS(d.msId);
  if (!po || po.billingMethod !== 'Milestone') return NO('Advances are available on Milestone POs only.');
  if (po.status !== 'Approved') return NO(`${po.number} is ${po.status}. An advance can be requested only after the PO and its schedule are approved.`);
  if (!m || m.poId !== po.id) return NO('Select the milestone the advance is for.');
  if (m.status === 'Draft') return NO('The milestone schedule is not approved yet.');
  if (!m.advance || !m.advance.allowed) return NO(`${m.code} has no advance terms. Advance terms are set by the buyer with the schedule.`);
  if (usage('milestone', m.id).value >= m.amount - EPS) return NO(`${m.code} is already fully invoiced — an advance is paid before the work is billed, so there is nothing left to advance.`);
  const open = advOfMs(m).find(ADV_OPEN);
  if (open) return NO(`Advance ${open.number} on ${m.code} is still ${advStatus(open)}. A second advance is allowed only after the first is Recovered or Refunded.`);
  const base = r2(+d.base || 0), tdsPct = +d.tdsPct || 0, errs = [];
  if (!(base > 0)) errs.push('Enter the advance base amount.');
  if (!TDS_RATES.includes(tdsPct)) errs.push('Select a valid TDS rate.');
  if (base > 0) advCapErrors(po, m, base).forEach(e => errs.push(e));
  if (errs.length) return NO(errs);
  const rate = gstOf(po), gst = poCfg(po).advanceGstMode === 'taxed_on_advance' ? r2(base * rate / 100) : 0, tds = r2(base * tdsPct / 100), total = r2(base + gst);
  const seq = advsOf(po).length + 1;
  const a = { id: uid('adv'), poId: po.id, msId: m.id, number: `ADV-${pad(seq)}`, base, gstPct: rate, gst, tdsPct, tds, total, payable: r2(total - tds), remarks: d.remarks || '', attachments: d.attachments || [],
    recovery: m.advance.recovery, guaranteeRequired: !!m.advance.guaranteeRequired, guaranteeTitle: m.advance.guaranteeTitle, guarantee: null, requestedBy: actor(), requestedRole: db.meta.role, requestedAt: nowISO(),
    approved: false, rejected: false, invoiceId: null, refunded: 0, history: [{ at: nowISO(), by: actor(), action: 'Requested', note: money(base) }] };
  advList().push(a);
  audit(po.id, `${po.number} / ${m.code}`, `Advance ${a.number} of ${money(base)} requested against ${m.code} "${m.name}"${a.guaranteeRequired ? ` — ${a.guaranteeTitle} required` : ''}.`, 'ms'); save();
  return OK(`${a.number} requested`, { id: a.id });
};
A.advUploadGuarantee = (id, d) => { const a = getAdv(id); if (!a || a.rejected) return NO('Advance not found.'); if (!a.guaranteeRequired) return NO(`${a.number} does not require a guarantee.`); if (!(+d.amount >= a.base - EPS)) return NO(`The guarantee must cover the advance: ${money(a.base)} is advanced but the guarantee is for ${money(+d.amount || 0)}.`); const po = getPO(a.poId); return putGuarantee(a, a.guaranteeTitle, d, `${po.number} / ${a.number}`, po.id); };
A.advVerifyGuarantee = id => { const a = getAdv(id); if (!a) return NO('Advance not found.'); const po = getPO(a.poId), e = decideGuarantee(a, true, '', `${po.number} / ${a.number}`, po.id); if (e) return e; save(); return OK(`${a.guaranteeTitle} verified`); };
A.advRejectGuarantee = (id, reason) => { const a = getAdv(id); if (!a) return NO('Advance not found.'); const po = getPO(a.poId), e = decideGuarantee(a, false, reason, `${po.number} / ${a.number}`, po.id); if (e) return e; save(); return OK(`${a.guaranteeTitle} rejected`); };
A.approveAdvance = (id, note) => {
  const a = getAdv(id); if (!a || a.rejected) return NO('Advance not found.');
  if (a.approved) return NO(`${a.number} is already approved.`);
  const po = getPO(a.poId), m = getMS(a.msId);
  if ((db.meta.role !== 'admin' || !cfg().adminExemptFromSod) && a.requestedRole === db.meta.role) return NO(`Segregation of duties: ${a.requestedBy} requested ${a.number}, so the same role cannot approve it.`);
  const errs = advCapErrors(po, m, a.base, a); if (errs.length) return NO(errs);
  a.approved = true; a.approvedBy = actor(); a.approvedAt = nowISO(); a.history.push({ at: nowISO(), by: actor(), action: 'Approved', note: note || '' });
  const st = advStatus(a); audit(po.id, `${po.number} / ${a.number}`, `Advance ${a.number} approved${note ? ': ' + note : ''} — status ${st}${st === 'Guarantee pending' ? `; the supplier can invoice only after Finance verifies the ${a.guaranteeTitle}` : '; the supplier can now raise the advance invoice'}.`, 'ok'); save();
  return OK(`${a.number} approved — ${st}`);
};
A.rejectAdvance = (id, reason) => {
  const a = getAdv(id); if (!a || a.rejected) return NO('Advance not found.');
  if (advInvoiceOf(a) && isLive(advInvoiceOf(a))) return NO(`${a.number} already has a live advance invoice — reject or cancel that first.`);
  if (!String(reason || '').trim()) return NO('A rejection reason is required.');
  a.rejected = true; a.rejectReason = reason; a.history.push({ at: nowISO(), by: actor(), action: 'Rejected', note: reason });
  audit(a.poId, `${getPO(a.poId).number} / ${a.number}`, `Advance ${a.number} rejected: ${reason}.`, 'bad'); save(); return OK(`${a.number} rejected`);
};
/* unused advance returned by the supplier: only a refund (not a credit note) reduces P; it frees the milestone for cancellation */
A.refundAdvance = (id, d) => {
  const a = getAdv(id), inv = a && advInvoiceOf(a); if (!a) return NO('Advance not found.');
  if (!inv || inv.status !== 'Paid' || inv.reversed) return NO('Only a paid advance can be refunded.');
  const O = advO(a); if (!(O > EPS)) return NO(`${a.number} has nothing outstanding to refund.`);
  const amt = r2(d && d.amount != null && d.amount !== '' ? +d.amount : O);
  if (!(amt > 0) || amt > O + EPS) return NO(`Refund must be between 0 and the outstanding advance ${money(O)}.`);
  if (!String((d && d.reason) || '').trim()) return NO('A refund reason is required.');
  a.refunded = r2((a.refunded || 0) + amt); a.history.push({ at: nowISO(), by: actor(), action: 'Refunded', note: `${money(amt)} — ${d.reason}` });
  audit(a.poId, `${getPO(a.poId).number} / ${a.number}`, `Advance ${a.number}: ${money(amt)} refunded by the supplier (${d.reason}). Outstanding now ${money(advO(a))}.`, 'ok'); save();
  return OK(`${money(amt)} refunded on ${a.number}`);
};
/* a posted / paid advance invoice may not be undone while later invoices already recovered it */
const advBlock = inv => {
  if (!inv.advanceId) return '';
  const a = getAdv(inv.advanceId), R = a ? advR(a, inv.id) : 0;
  return R > EPS ? `${a.number} has ${money(R)} already recovered on later milestone invoices. Reverse or cancel those first (or refund the advance).` : '';
};

/* ---------- invoice integration: advance as a source, recovery lines ---------- */
function advSourceItems(po, ex) {
  return advsOf(po).filter(a => !a.rejected).map(a => {
    const m = getMS(a.msId), st = advStatus(a), other = advLiveInv(a, ex), eligible = !other && (st === 'Approved' || (ex && advInvoiceOf(a) && advInvoiceOf(a).id === ex && a.approved));
    const reason = other ? `Already invoiced on ${invRef(other)} (${other.status})` : st === 'Requested' ? 'Waiting for the approver' : st === 'Guarantee pending' ? `Waiting for Finance to verify the ${a.guaranteeTitle}` : eligible ? '' : `Advance is ${st}`;
    return { kind: 'advance', refId: a.id, ref: a, label: a.number, name: `Advance — ${m ? m.code + ' ' + m.name : ''}`, status: st, entQty: null, entValue: eligible || other ? a.base : 0, usedQty: 0, usedValue: other ? other.net : 0, committedValue: 0, reservedValue: 0,
      availQty: null, availValue: eligible ? a.base : 0, eligible, reason, invs: other ? [other] : [], dup: !!other };
  });
}
function advAllocError(a, it, add, inv, po) {
  if (!it.eligible) return add(it.dup ? 'DUP_ALLOC' : 'NOT_ELIGIBLE', it.dup ? `Duplicate allocation blocked: advance ${it.label} (${money(it.ref.base)}) is already invoiced. ${it.reason}.` : `${it.label} is not invoice-eligible: ${it.reason}.`, it.label);
  if (Math.abs(a.value - it.ref.base) > EPS) add('MS_FULL', `Advance ${it.label} must be invoiced for its full approved amount (${money(it.ref.base)}). Requested: ${money(a.value)}.`, it.label);
}
function computeRecoveries(inv) {
  const out = { items: [], net: 0, gst: 0 }, po = getPO(inv.poId);
  if (!po || po.billingMethod !== 'Milestone' || inv.advanceId || !(inv.allocs || []).length) return out;
  const mode = poCfg(po).advanceGstMode, rate = gstOf(po);
  inv.allocs.filter(a => a.kind === 'milestone').forEach(a => {
    const m = getMS(a.refId); if (!m) return;
    advOfMs(m).forEach(adv => {
      const P = advP(adv, inv.id); if (!(P > EPS)) return;
      const R = advR(adv, inv.id), O = r2(P - R - (adv.refunded || 0)); if (O <= EPS) return;
      const usedBefore = usage('milestone', m.id, inv.id).value, last = r2(usedBefore + a.value) >= m.amount - EPS;
      let rec = adv.recovery === 'first' ? Math.min(O, a.value) : Math.min(O, r2(a.value * P / m.amount));
      if (last) rec = Math.min(O, a.value);                                                                // the last invoice on the milestone recovers all that remains, capped at its net
      rec = r2(Math.min(rec, a.value)); if (rec <= EPS) return;
      out.items.push({ advId: adv.id, number: adv.number, msId: m.id, net: rec, shortfall: r2(O - rec) });
    });
  });
  out.net = sum(out.items, x => x.net); out.gst = mode === 'taxed_on_advance' ? r2(out.net * rate / 100) : 0;
  return out;
}
function refreshRecovery(inv) {
  const fresh = computeRecoveries(inv), old = inv.recovery || { items: [], net: 0, gst: 0 };
  if (fresh.net !== old.net || fresh.gst !== old.gst) { inv.recovery = fresh; audit(inv.poId, invRef(inv), `Advance recovery on ${invRef(inv)} recalculated to ${money(fresh.net)} from today's balances.`, 'alloc'); }
  const dm = computeDamages(inv); if (dm.total !== damagesCash(inv)) { inv.damages = dm; audit(inv.poId, invRef(inv), `Delay damages on ${invRef(inv)} recalculated to ${money(dm.total)}.`, 'alloc'); }
}

/* ---------- reports (spec 8.7) ---------- */
function outstandingAdvances() {
  return advList().filter(a => !a.rejected).map(a => { const inv = advInvoiceOf(a), po = getPO(a.poId), m = getMS(a.msId);
    if (!inv || inv.status !== 'Paid' || inv.reversed) return null;
    const P = advP(a), R = advR(a), O = advO(a); if (!(O > EPS)) return null;
    return { adv: a, po, m, P, R, O, days: inv.ap && inv.ap.paidAt ? Math.floor((Date.now() - new Date(inv.ap.paidAt).getTime()) / 864e5) : 0 }; }).filter(Boolean).sort((x, y) => y.days - x.days);
}
function expiringGuarantees(withinDays = 30) {
  const out = [], lim = daysFromNow(withinDays);
  db.milestones.forEach(m => { const po = getPO(m.poId); if (m.needsGuarantee && m.guarantee && m.guarantee.validUntil && m.guarantee.status !== 'Rejected' && m.guarantee.validUntil <= lim) out.push({ kind: 'Milestone', ref: `${po.number} / ${m.code}`, title: m.guaranteeTitle, g: m.guarantee, state: gState(m.guarantee), poId: po.id }); });
  advList().forEach(a => { if (a.guarantee && a.guarantee.validUntil && a.guarantee.status !== 'Rejected' && a.guarantee.validUntil <= lim && !['Recovered', 'Refunded', 'Rejected'].includes(advStatus(a))) { const po = getPO(a.poId); out.push({ kind: 'Advance', ref: `${po.number} / ${a.number}`, title: a.guaranteeTitle, g: a.guarantee, state: gState(a.guarantee), poId: po.id }); } });
  return out.sort((x, y) => x.g.validUntil.localeCompare(y.g.validUntil));
}
function reviewItems() {
  return db.invoices.map(i => { const r = apReview(i); if (!r) return null;
    const recs = i.allocs.flatMap(a => a.kind === 'milestone' ? [...(getMS(a.refId).grnIds || []).map(getGRN), ...(getMS(a.refId).srnIds || []).map(getSRN)] : [a.kind === 'grn' ? getGRN(a.refId) : a.kind === 'srn' ? getSRN(a.refId) : null]).filter(Boolean);
    const type = recs.some(x => x.reversed) ? 'Receipt reversal' : recs.some(x => (x.accepted != null ? x.accepted : x.acceptedValue) === 0) ? 'Receipt reduction' : 'Advance / entitlement';
    return { inv: i, po: getPO(i.poId), type, amount: r.amount, refs: r.refs }; }).filter(Boolean);
}

/* =====================================================================
   Multi-line invoice intake (spec 7.4–7.5). A supplier invoice arrives with N lines and no milestone references:
   each line is matched to a PO line and a milestone portion, then checked in a fixed order. Results: Billable · Waiting · Reject.
   ===================================================================== */
const tokens = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
function matchPoLine(po, r) {
  if (r.lineId) return lineOf(po, r.lineId) || null;
  const ref = String(r.ref || '').trim().toLowerCase().replace(/^(l|line|#)\s*/, '');
  if (ref) { const l = po.lines.find(x => String(x.no) === ref || x.id.toLowerCase() === String(r.ref).trim().toLowerCase()); if (l) return l; }
  const t = tokens(r.desc); if (!t.size) return null;
  const sc = po.lines.map(l => { const lt = tokens(l.desc), inter = [...t].filter(w => lt.has(w)).length; return { l, j: inter / (t.size + lt.size - inter || 1) }; }).sort((a, b) => b.j - a.j);
  return sc[0] && sc[0].j >= 0.34 && (!sc[1] || sc[0].j > sc[1].j) ? sc[0].l : null;
}
function matchInvoiceLines(po, rows, opts = {}) {
  const tol = poCfg(po).valueTolerancePct, res = [], seen = new Map(), used = {}, outsideUsed = {}, poLeft0 = r2(poNet(po) - poConsumed(po, opts.exInv));
  let running = 0;
  rows.forEach((r, n) => {
    const row = { n: n + 1, ref: r.ref || '', desc: r.desc || '', qty: r.qty === '' || r.qty == null ? null : +r.qty, rate: r.rate === '' || r.rate == null ? null : +r.rate, amount: r2(+r.amount || (r.qty && r.rate ? +r.qty * +r.rate : 0)), taxRate: r.taxRate === '' || r.taxRate == null ? null : +r.taxRate, status: '', reason: '', billable: 0, excess: 0, lineId: null, msId: null, allocKind: null };
    const done = (status, reason) => { row.status = status; row.reason = reason; res.push(row); };
    const line = matchPoLine(po, r); // 1
    if (!line) return done('Reject', 'No PO match — the line could not be matched to any PO line. Pick the PO line or correct the reference.');
    row.lineId = line.id; row.lineLabel = `L${line.no} ${line.desc}`;
    if (!(row.amount > 0)) return done('Reject', 'The line amount is zero or missing.');
    const key = [line.id, r.msId || '', row.qty, row.amount].join('|'), prev = seen.get(key);              // 2
    if (prev) return done('Reject', `Duplicate of line ${prev} on this invoice.`);
    seen.set(key, row.n);
    if (r.uom && r.uom !== line.uom) { const f = +((line.convs || {})[r.uom]); if (!(f > 0)) return done('Reject', `Unit ${r.uom} differs from ${line.uom} and the PO line has no conversion factor.`); if (row.rate != null) row.rate = r2(row.rate / f); if (row.qty != null) row.qty = r2(row.qty * f); }   // I13
    if (row.rate != null) { const dev = line.price ? Math.abs(row.rate - line.price) / line.price * 100 : 0; if (dev > tol + 1e-9) return done('Reject', `Rate ${money(row.rate)} differs from the PO rate ${money(line.price)}${tol ? ` (tolerance ${tol}%)` : ''}.`); }   // 3
    if (row.taxRate != null && row.taxRate !== (line.gstRate != null ? line.gstRate : gstOf(po))) return done('Reject', `Tax rate ${row.taxRate}% differs from the ${line.gstRate != null ? line.gstRate : gstOf(po)}% on the PO line.`);   // 6 (done early: a rejected line consumes nothing)
    let cap = 0, target = null, why = '';
    if (isOutside(line)) {                                                                                  // outside-schedule lines bill on accepted receipts
      const its = sourceItems(po, opts.exInv).filter(x => (x.kind === 'grn' || x.kind === 'srn') && x.line && x.line.id === line.id);
      const avail = its.filter(x => x.eligible);
      if (!avail.length) return done('Waiting', its.length ? `No accepted receipt with balance on this outside-schedule line (${its.map(x => `${x.label}: ${x.reason || x.status}`).join('; ')}).` : 'No receipt yet for this line, which is billed outside the schedule — it needs an accepted GRN / SRN.');
      let need = row.amount, take = [];
      avail.forEach(x => { const left = r2(x.availValue - (outsideUsed[x.refId] || 0)); if (need > EPS && left > EPS) { const v = Math.min(need, left); take.push({ x, v }); outsideUsed[x.refId] = r2((outsideUsed[x.refId] || 0) + v); need = r2(need - v); } });
      const got = r2(row.amount - need);
      if (got <= EPS) return done('Waiting', 'Over quantity — every accepted receipt on this line is already used on this invoice.');
      row.allocKind = 'receipt'; row.receipts = take.map(t => ({ kind: t.x.kind, refId: t.x.refId, value: t.v, qty: t.x.kind === 'grn' ? r2(t.v / line.price) : null }));
      row.billable = got; row.excess = need; row.reason = need > EPS ? `Receipts cover ${money(got)}; the excess ${money(need)} is reported.` : 'Billed on accepted receipts.';
      running = r2(running + got); row.status = 'Billable'; return res.push(row);
    }
    const cands = msOf(po).filter(m => inScope(m, line.id) && (!r.msId || m.id === r.msId));                // 4: milestone state
    if (!cands.length) return done('Reject', r.msId ? 'The selected milestone does not cover this PO line.' : 'No milestone covers this PO line.');
    let pick = null; const reasons = [];
    for (const m of cands) {
      const sl = sliceRemaining(m, po, opts.exInv).find(x => x.line.id === line.id); if (!sl) continue;
      const g = msGate(m, po), key2 = m.id + ':' + line.id, already = sl.used >= sl.value - EPS || (sl.ent > EPS && sl.used >= sl.ent - EPS && !used[key2]);
      if (already) { const ids = allocsOn('milestone', m.id, opts.exInv).map(x => invRef(x.inv)); reasons.push({ t: 'billed', m, txt: `${m.code} is already invoiced for this line${ids.length ? ' on ' + [...new Set(ids)].join(', ') : ''}` }); continue; }
      if (m.status !== 'Approved') { reasons.push({ t: 'wait', m, txt: `${m.code} is not approved (status ${m.status})` }); continue; }
      if (!g.ok) { reasons.push({ t: 'wait', m, txt: `${m.code} is approved but ${g.reason}` }); continue; }
      if (unmetDeps(m, po, 'bill').length) { reasons.push({ t: 'wait', m, txt: depMsg(m, unmetDeps(m, po, 'bill'), depJoin(m)) }); continue; }
      const left = r2(sl.remaining - (used[m.id + ':' + line.id] || 0));
      if (!m.allowPartial && sl.ent < m.amount - EPS && sum(allocsOn('milestone', m.id, opts.exInv), x => x.a.value) <= EPS) { reasons.push({ t: 'wait', m, txt: `${m.code} is billed once, in full, and only ${money(sl.ent)} of its scope is accepted so far` }); continue; }
      if (left <= EPS) { reasons.push({ t: 'wait', m, txt: `Over quantity: nothing more on ${m.code} is receipted for this line` }); continue; }
      pick = { m, left, sl }; break;
    }
    if (!pick) { const w = reasons.find(x => x.t === 'wait'); return reasons.length && !w ? done('Reject', `Already billed — ${reasons.map(x => x.txt).join('; ')}.`) : done('Waiting', reasons.map(x => x.txt).join('; ') || 'Nothing is eligible yet.'); }
    cap = pick.left; const take = Math.min(row.amount, cap);                                                 // 5: remaining on the slice, earlier lines consume first
    const poLeft = r2(poLeft0 - running);                                                                   // 7: PO ceiling
    if (take > poLeft + EPS) { if (poLeft <= EPS) return done('Reject', `PO ceiling reached — nothing remains on the PO (${money(poNet(po))}).`); row.billable = poLeft; row.excess = r2(row.amount - poLeft); row.reason = `PO ceiling: only ${money(poLeft)} remains; the excess ${money(row.excess)} is reported.`; }
    else { row.billable = r2(take); row.excess = r2(row.amount - take); row.reason = row.excess > EPS ? `Only ${money(take)} is eligible on ${pick.m.code}; the excess ${money(row.excess)} is reported.` : `Billed on ${pick.m.code}.`; }
    row.msId = pick.m.id; row.msCode = pick.m.code; row.qtyBillable = line.price ? r2(row.billable / line.price) : null;
    used[pick.m.id + ':' + line.id] = r2((used[pick.m.id + ':' + line.id] || 0) + row.billable); running = r2(running + row.billable); row.status = 'Billable'; res.push(row);
  });
  const groups = { Billable: res.filter(x => x.status === 'Billable'), Waiting: res.filter(x => x.status === 'Waiting'), Reject: res.filter(x => x.status === 'Reject') };
  const claimed = sum(res, x => x.amount), billable = sum(groups.Billable, x => x.billable);
  const allocs = [], byMs = new Map();
  groups.Billable.forEach(x => { if (x.msId) { if (!byMs.has(x.msId)) byMs.set(x.msId, []); byMs.get(x.msId).push(x); } });
  byMs.forEach((list, msId) => allocs.push({ kind: 'milestone', refId: msId, qty: null, value: sum(list, x => x.billable), lines: list.map(x => ({ lineId: x.lineId, value: x.billable, qty: x.qtyBillable, ...(x.taxRate != null ? { gstRate: x.taxRate } : {}) })) }));
  const rc = new Map();
  groups.Billable.filter(x => x.allocKind === 'receipt').forEach(x => x.receipts.forEach(t => { const k = t.kind + ':' + t.refId, c = rc.get(k) || { kind: t.kind, refId: t.refId, qty: t.kind === 'grn' ? 0 : null, value: 0 }; c.value = r2(c.value + t.value); if (t.kind === 'grn') c.qty = r2(c.qty + t.qty); rc.set(k, c); }));
  rc.forEach(c => allocs.push(c));
  const msg = [`Invoice ${opts.number || ''} — ${res.length} line(s): ${groups.Billable.length} billable (${money(billable)}), ${groups.Waiting.length} waiting, ${groups.Reject.length} rejected.`,
    ...res.filter(x => x.status !== 'Billable' || x.excess > EPS).map(x => `Line ${x.n} (${x.desc || x.ref}): ${x.status === 'Billable' ? 'Billable in part' : x.status} — ${x.reason}`)].join('\n');
  return { rows: res, groups, claimed, billable, allocs, message: msg };
}
