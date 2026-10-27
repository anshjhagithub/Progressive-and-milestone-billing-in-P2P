/* =====================================================================
   logic.js — derived balances, validation, matching engine, state transitions
   No DOM access. Every balance shown anywhere in the UI is computed here
   from the underlying records (nothing is hard-coded into screens).

   Model rules that keep the flows consistent:
   - A PO is Goods (receipts = GRN), Services (receipts = SRN) or Mixed (each line is goods or a service).
   - A milestone is billable only when it is APPROVED and every configured acceptance condition holds:
     document approval (evidence on the milestone itself), accepted GRN(s) for goods, accepted SRN(s) for services.
     Documents and receipts are separate records — a certificate never creates a GRN/SRN.
   - Milestone lifecycle: Pending → In Progress → Submitted for Approval → Under Review → Approved | Rejected (→ resubmit).
   - Certified work progress is a Services-only progressive basis, tracked at PO level.
   ===================================================================== */
const LIVE = ['Submitted', 'Pending Matching', 'Pending Approval', 'Approved', 'Posted', 'Paid'];   // invoice states that hold an allocation
const APPROVED = ['Approved', 'Posted', 'Paid'];
const GRN_OK = ['Accepted', 'Partially Accepted'];
const SRN_OK = ['Accepted', 'Partially Accepted'];
const isLive = i => LIVE.includes(i.status) && !i.reversed;     // a reversed (credited) invoice no longer holds an allocation

const getPO = id => db.pos.find(p => p.id === id);
const getSup = id => db.suppliers.find(s => s.id === id);
const getGRN = id => db.grns.find(g => g.id === id);
const getSRN = id => db.srns.find(s => s.id === id);
const getMS = id => db.milestones.find(m => m.id === id);
const getClaim = id => db.claims.find(c => c.id === id);
const getInv = id => db.invoices.find(i => i.id === id);
const lineOf = (po, id) => po.lines.find(l => l.id === id);
const poNet = po => sum(po.lines, l => l.qty * l.price);
const lineNet = l => r2(l.qty * l.price);
const grnsOf = po => db.grns.filter(g => g.poId === po.id).sort((a, b) => a.seq - b.seq);
const srnsOf = po => db.srns.filter(s => s.poId === po.id).sort((a, b) => a.seq - b.seq);
const msOf = po => db.milestones.filter(m => m.poId === po.id).sort((a, b) => a.seq - b.seq);
const claimsOf = po => db.claims.filter(c => c.poId === po.id).sort((a, b) => a.seq - b.seq);
const invsOf = po => db.invoices.filter(i => i.poId === po.id);
const poAllocatable = po => po.status === 'Approved';
const lineKind = (po, l) => po.type === 'Mixed' ? (l.kind === 'Services' ? 'Services' : 'Goods') : po.type;
const goodsLines = po => po.lines.filter(l => lineKind(po, l) === 'Goods');
const serviceLines = po => po.lines.filter(l => lineKind(po, l) === 'Services');
const hasGoods = po => goodsLines(po).length > 0, hasServices = po => serviceLines(po).length > 0;
const isGoods = po => po.type === 'Goods';                                  // purely goods
const recLabel = po => po.type === 'Mixed' ? 'GRN / SRN' : po.type === 'Goods' ? 'GRN' : 'SRN';
const poCertified = po => po.billingMethod === 'Progressive' && po.progressBasis === 'Certified';
const methodLabel = po => po.billingMethod === 'Progressive' ? (poCertified(po) ? 'Progressive · Certified progress' : 'Progressive · Receipt-based') : po.billingMethod;
const msFull = m => `${m.code} — ${m.name}`;
const gstOf = po => po.gstRate ?? GST_DEFAULT;

/* ---------- allocations: who is consuming what ---------- */
function allocsOn(kind, refId, exId) {
  const out = [];
  db.invoices.forEach(i => { if (!isLive(i) || i.id === exId) return; i.allocs.forEach(a => { if (a.kind === kind && a.refId === refId) out.push({ inv: i, a }); }); });
  return out;
}
function usage(kind, refId, exId) {
  const l = allocsOn(kind, refId, exId);
  const committed = l.filter(x => APPROVED.includes(x.inv.status)), reserved = l.filter(x => !APPROVED.includes(x.inv.status));
  return {
    qty: sum(l, x => x.a.qty || 0), value: sum(l, x => x.a.value), invs: [...new Set(l.map(x => x.inv))],
    committedQty: sum(committed, x => x.a.qty || 0), committedValue: sum(committed, x => x.a.value),
    reservedQty: sum(reserved, x => x.a.qty || 0), reservedValue: sum(reserved, x => x.a.value),
  };
}

/* ---------- goods receipts (GRN) ---------- */
const grnEnt = g => (GRN_OK.includes(g.status) && !g.reversed) ? g.accepted : 0;
const grnActiveQty = g => g.reversed ? 0 : (g.status === 'Pending Inspection' ? g.received : g.accepted);
function lineReceiptStats(po, line, exGrnId) {
  const gs = grnsOf(po).filter(g => g.lineId === line.id && g.id !== exGrnId);
  const active = sum(gs, grnActiveQty);
  const maxQty = r2(line.qty * (1 + (po.overReceiptPct || 0) / 100));
  return {
    ordered: line.qty, maxQty, active, remaining: r2(Math.max(0, maxQty - active)),
    receivedQty: sum(gs.filter(g => !g.reversed), g => g.received),
    acceptedQty: sum(gs, grnEnt), rejectedQty: sum(gs.filter(g => !g.reversed), g => g.rejected),
    pendingQty: sum(gs.filter(g => !g.reversed && g.status === 'Pending Inspection'), g => g.received),
  };
}
/* milestone ↔ receipt link validation shared by GRN / SRN creation and the link action */
/* once a milestone has billed value, a NEW receipt may not reopen a hard receipt gate behind it (percent / amount slices); quantity slices only ever count accepted units, so staged deliveries keep linking */
const hardReceiptGate = (m, po) => { const sl = sliceInfo(m, po); return (m.needsGrn && sl.some(x => x.kind === 'Goods' && x.basis !== 'quantity')) || (m.needsSrn && sl.some(x => x.kind === 'Services' && x.basis !== 'quantity')); };
function checkReceiptLink(po, milestoneId, kind, lineId) {
  if (!milestoneId) return [];
  const m = getMS(milestoneId), L = kind.toUpperCase();
  if (!m || m.poId !== po.id) return ['The selected milestone does not belong to this PO.'];
  if (!(kind === 'grn' ? m.needsGrn : m.needsSrn)) return [`${m.code} is not configured to require a ${L}.`];
  if (lineId && !inScope(m, lineId)) { const l = lineOf(po, lineId); return [`Line ${l ? l.no : '?'} (${l ? l.desc : ''}) is not in the scope of ${m.code}, so a receipt for it cannot back this milestone.`]; }
  if (usage('milestone', m.id).value > EPS && hardReceiptGate(m, po)) return [`${m.code} already has invoices against it — a new ${L} can no longer be linked (it would reopen the acceptance gate behind billed value).`];
  return [];
}
function validateGRN(d) {
  const po = getPO(d.poId), errs = [];
  if (!po) return ['Select an approved purchase order with goods lines.'];
  if (po.status !== 'Approved') return [`${po.number} is ${po.status}. Goods receipts can only be created against an approved PO.`];
  if (!hasGoods(po)) return [`${po.number} has no goods lines — record services with a service receipt (SRN) instead of a GRN.`];
  const line = lineOf(po, d.lineId);
  if (!line) return ['Select a PO line.'];
  if (d.date && d.date > todayISO()) errs.push(`Receipt date ${fmtD(d.date)} is in the future.`);
  if (d.date && po.poDate && d.date < po.poDate) errs.push(`Receipt date ${fmtD(d.date)} is before the PO date ${fmtD(po.poDate)}.`);
  if (lineKind(po, line) !== 'Goods') return [`Line ${line.no} is a services line — record it with an SRN, not a GRN.`];
  const st = lineReceiptStats(po, line, d.id);
  if (!(d.received > 0)) errs.push('Delivered quantity must be greater than zero.');
  if (d.received > st.remaining + EPS) errs.push(`Delivered quantity (${fmtNum(d.received)}) exceeds the remaining PO quantity (${fmtNum(st.remaining)} ${line.uom}) on line ${line.no}.`);
  if (d.accepted < 0 || d.rejected < 0) errs.push('Accepted and rejected quantities cannot be negative.');
  if (r2(d.accepted + d.rejected) > d.received + EPS) errs.push(`Accepted (${fmtNum(d.accepted)}) + rejected (${fmtNum(d.rejected)}) cannot exceed delivered quantity (${fmtNum(d.received)}).`);
  checkReceiptLink(po, d.milestoneId, 'grn', d.lineId).forEach(e => errs.push(e));
  return errs;
}

/* ---------- service receipts (SRN) ---------- */
const srnActive = s => (s.status === 'Rejected' || s.reversed) ? 0 : (SRN_OK.includes(s.status) ? s.acceptedValue : s.serviceValue);
const srnEnt = s => (SRN_OK.includes(s.status) && !s.reversed) ? s.acceptedValue : 0;
function lineServiceStats(po, line, exId) {
  const ss = srnsOf(po).filter(s => s.lineId === line.id && s.id !== exId);
  return { total: lineNet(line), active: sum(ss, srnActive), accepted: sum(ss, srnEnt), remaining: r2(Math.max(0, lineNet(line) - sum(ss, srnActive))) };
}
function validateSRN(d) {
  const po = getPO(d.poId), errs = [];
  if (!po) return ['Select an approved purchase order with service lines.'];
  if (po.status !== 'Approved') return [`${po.number} is ${po.status}. Service receipts can only be created against an approved PO.`];
  if (!hasServices(po)) return [`${po.number} has no service lines — record goods with a goods receipt (GRN) instead of an SRN.`];
  const line = lineOf(po, d.lineId); if (!line) return ['Select a PO line.'];
  if (d.date && d.date > todayISO()) errs.push(`Receipt date ${fmtD(d.date)} is in the future.`);
  if (d.date && po.poDate && d.date < po.poDate) errs.push(`Receipt date ${fmtD(d.date)} is before the PO date ${fmtD(po.poDate)}.`);
  if (lineKind(po, line) !== 'Services') return [`Line ${line.no} is a goods line — record it with a GRN, not an SRN.`];
  const st = lineServiceStats(po, line, d.id);
  if (!(d.serviceValue > 0)) errs.push('Service value must be greater than zero.');
  if (d.serviceValue > st.remaining + EPS) errs.push(`Service value ${money(d.serviceValue)} exceeds the remaining value ${money(st.remaining)} on line ${line.no}.`);
  if (!String(d.description || '').trim()) errs.push('Describe the service received.');
  checkReceiptLink(po, d.milestoneId, 'srn', d.lineId).forEach(e => errs.push(e));
  return errs;
}

/* ---------- milestones ---------- */
/* A milestone covers a SCOPE of PO lines. Each scope row is a slice of one line on one basis:
     quantity → units (or service value) of the line · percent → % of the line · amount → a lump sum
   The milestone amount is derived from its slices (never typed); a legacy "% of PO" milestone is simply a percent slice of every scheduled line.
   Lines flagged "billed outside schedule" carry no scope and bill on accepted receipts like Progressive.
   Acceptance conditions are configured per milestone and are independent records:
     document approval · accepted GRN(s) / SRN(s) · complete quantity · verified guarantee
   A certificate never creates a receipt, and a receipt never approves a milestone. */
const isOutside = l => !!l.outside;
const explicitScope = m => !!(m.scope && m.scope.length && !m.simple);
const scheduleBase = lines => r2(lines.filter(l => !isOutside(l)).reduce((a, l) => a + (+l.qty || 0) * (+l.price || 0), 0));
const BASIS_LABEL = { quantity: 'Quantity', percent: '% of line', amount: 'Amount' };
const simpleScope = (lines, pct) => lines.filter(l => !isOutside(l)).map(l => ({ lineId: l.id, basis: 'percent', percent: +pct }));
const sliceRaw = (s, line) => s.basis === 'quantity' ? r2((+s.qty || 0) * (+line.price || 0)) : s.basis === 'percent' ? r2((+s.percent || 0) * (+line.qty || 0) * (+line.price || 0) / 100) : r2(+s.amount || 0);
const ensureLineIds = lines => lines.forEach((l, i) => { if (!l.id) l.id = `ln_${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 5)}`; });
const fq = n => fmtNum(Math.round(n * 100) / 100);
const qtyOf = (n, t, unit) => unit === '%' ? `${fq(n)}% of ${fq(t)}%` : `${fq(n)} of ${fq(t)} ${unit}`;
function buildSchedule(lines, ms) {
  const errs = [], lbl = l => `L${lines.indexOf(l) + 1} (${String(l.desc || 'item').slice(0, 40)})`, sched = lines.filter(l => !isOutside(l));
  const explicit = ms.some(explicitScope), base = scheduleBase(lines), mcode = (m, i) => m.code || 'M' + (i + 1);
  const scopes = ms.map(m => (explicitScope(m) ? m.scope : simpleScope(lines, m.pct)).map(x => ({ ...x })));
  const values = scopes.map(sc => sc.map(() => 0)), per = new Map(), cov = [];
  scopes.forEach((sc, mi) => { const seen = new Set(), code = mcode(ms[mi], mi);
    if (!sc.length) errs.push(`${code}: add at least one line to the scope.`);
    sc.forEach((x, si) => {
      const line = lines.find(l => l.id === x.lineId);
      if (!line) { errs.push(`${code}: a scope row refers to a line that does not exist.`); return; }
      if (!BASIS_LABEL[x.basis]) { errs.push(`${code}: choose a basis (quantity, % of line or amount) for ${lbl(line)}.`); return; }
      if (seen.has(x.lineId)) errs.push(`${code}: ${lbl(line)} appears twice in the scope — a line can be listed at most once per milestone.`);
      seen.add(x.lineId);
      if (!(+(x.basis === 'quantity' ? x.qty : x.basis === 'percent' ? x.percent : x.amount) > 0)) errs.push(`${code}: the ${BASIS_LABEL[x.basis].toLowerCase()} for ${lbl(line)} must be greater than zero.`);
      if (isOutside(line)) errs.push(`${lbl(line)} is billed outside the schedule but ${code} has scope on it. Remove the scope row or clear the flag.`);
      if (!per.has(line.id)) per.set(line.id, []);
      per.get(line.id).push({ mi, si, s: x });
    }); });
  sched.forEach(l => {
    const list = per.get(l.id) || [], bases = [...new Set(list.map(x => x.s.basis))].filter(b => BASIS_LABEL[b]);
    if (!list.length) { cov.push({ lineId: l.id, label: lbl(l), basis: null, assigned: 0, total: l.qty, diff: l.qty, unit: l.uom }); if (explicit) errs.push(`${lbl(l)} has ${fq(l.qty)} of ${fq(l.qty)} ${l.uom} not assigned to any milestone. Assign them, or mark the line as billed outside the schedule.`); return; }
    if (bases.length > 1) { errs.push(`${lbl(l)} mixes ${bases.map(b => BASIS_LABEL[b].toLowerCase()).join(' and ')} rows across milestones; use one basis per line.`); return; }
    const b = bases[0]; if (!b) return;
    list.forEach(x => { values[x.mi][x.si] = sliceRaw(x.s, l); });
    const assigned = sum(list, x => b === 'quantity' ? x.s.qty : b === 'percent' ? x.s.percent : x.s.amount), total = b === 'quantity' ? l.qty : b === 'percent' ? 100 : lineNet(l), diff = r2(total - assigned);
    const unit = b === 'quantity' ? l.uom : b === 'percent' ? '%' : 'INR', u = unit === '%' ? '%' : ' ' + unit;
    cov.push({ lineId: l.id, label: lbl(l), basis: b, assigned, total, diff, unit });
    if (Math.abs(b === 'percent' ? total - list.reduce((a, x) => a + (+x.s.percent || 0), 0) : diff) < (b === 'percent' ? 1e-6 : EPS)) {
      if (b !== 'amount') { const last = list[list.length - 1]; values[last.mi][last.si] = r2(lineNet(l) - sum(list.slice(0, -1), x => values[x.mi][x.si])); }   // last slice absorbs rounding
    } else if (explicit) errs.push(diff > 0 ? `${lbl(l)} has ${qtyOf(diff, total, unit)} not assigned to any milestone. Assign them, or mark the line as billed outside the schedule.` : `${lbl(l)} is assigned ${qtyOf(assigned, total, unit)}. Reduce the scope on a milestone by ${fq(-diff)}${unit === '%' ? '%' : ' ' + unit}.`);
  });
  const amounts = values.map(v => sum(v, x => x));
  return { amounts, values, scopes, base, explicit, errors: errs, coverage: cov, pcts: amounts.map(a => base ? Math.round(a / base * 1e8) / 1e6 : 0), ok: !errs.length };
}
/* ===== cumulative quantity trigger (brief case 3) =====
   A milestone can fire on the CUMULATIVE accepted receipt quantity of a goods line across all its GRNs (not on a date). The trigger decides WHEN the milestone is
   eligible; its scope decides WHAT it bills. On such a line the accepted units are pooled and served to the quantity slices in schedule order, so the units
   beyond one threshold count toward the next slice. */
function lineCum(po, lineId, thr) {
  const gs = db.grns.filter(g => g.poId === po.id && g.lineId === lineId && grnEnt(g) > 0).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (a.seq || 0) - (b.seq || 0));
  let cum = 0, firedBy = null; gs.forEach(g => { cum = r2(cum + grnEnt(g)); if (!firedBy && thr && cum >= thr - EPS) firedBy = g; });
  return { cum, firedBy, surplus: thr ? r2(Math.max(0, cum - thr)) : 0 };
}
const poolLine = (po, lineId) => msOf(po).some(q => q.trigger && q.trigger.lineId === lineId);
function poolShare(m, po, x) {
  const cum = lineCum(po, x.lineId).cum, prior = sum(msOf(po).filter(q => (q.seq || 0) < (m.seq || 0)), q => sum((q.scope || []).filter(s => s.lineId === x.lineId && s.basis === 'quantity'), s => +s.qty || 0));
  return r2(Math.max(0, Math.min(+x.qty, cum - prior)));
}
/* where the surplus of a fired trigger goes: the next milestone with a quantity slice on that line */
const triggerNext = (m, po) => m.trigger ? msOf(po).find(q => (q.seq || 0) > (m.seq || 0) && (q.scope || []).some(s => s.lineId === m.trigger.lineId && s.basis === 'quantity')) : null;
/* the scope of a stored milestone, with the slice values frozen at save time */
const sliceInfo = (m, po) => (m.scope || []).map(x => {
  const line = lineOf(po, x.lineId); if (!line) return null;
  const kind = lineKind(po, line), value = x.value ?? sliceRaw(x, line);
  let acc = 0;
  if (x.basis === 'quantity') acc = kind === 'Goods' && poolLine(po, line.id) ? r2(poolShare(m, po, x) * line.price) : kind === 'Goods' ? sum((m.grnIds || []).map(getGRN).filter(g => g && g.lineId === line.id), g => recShare(m, g, 'grn') * line.price) : sum((m.srnIds || []).map(getSRN).filter(q => q && q.lineId === line.id), q => recShare(m, q, 'srn'));
  if (m.measured && kind === 'Services' && x.basis !== 'quantity') { acc = sum((m.srnIds || []).map(getSRN).filter(q => q && q.lineId === line.id), q => recShare(m, q, 'srn')); return { s: x, line, kind, basis: x.basis, value, acc: r2(acc), ent: r2(Math.min(acc, value)) }; }   // I15 measured: bill the accepted service value only
  return { s: x, line, kind, basis: x.basis, value, acc: r2(acc), ent: x.basis === 'quantity' ? r2(Math.min(acc, value)) : value };
}).filter(Boolean);
const inScope = (m, lineId) => (m.scope || []).some(x => x.lineId === lineId);
/* a receipt may back several milestones when each link carries an explicit quantity; links are served in schedule order so no unit backs two slices */
const linksOf = r => r.links && r.links.length ? r.links : (r.milestoneId ? [{ msId: r.milestoneId, cap: null }] : []);
function recShare(m, rec, kind) {
  let left = kind === 'grn' ? grnEnt(rec) : srnEnt(rec); if (!(left > 0)) return 0;
  for (const lk of linksOf(rec).slice().sort((a, b) => ((getMS(a.msId) || {}).seq || 0) - ((getMS(b.msId) || {}).seq || 0))) {
    const take = lk.cap == null ? left : Math.min(+lk.cap, left);
    if (lk.msId === m.id) return r2(take);
    left = r2(left - take);
  }
  return 0;
}

const docTitleOf = m => m.docTitle || 'Supporting document';
const docState = m => !m.doc || !(m.doc.files || []).length ? 'Not Uploaded' : m.doc.status;           // Not Uploaded | Pending Approval | Approved | Rejected
const msAwaiting = m => ['Submitted for Approval', 'Under Review'].includes(m.status);
const MS_STATES = ['Pending', 'In Progress', 'Submitted for Approval', 'Under Review', 'Approved', 'Rejected'];
const msLocked = m => usage('milestone', m.id).value > EPS || ['Submitted for Approval', 'Under Review', 'Approved'].includes(m.status);
function recCond(m, kind) {
  const ids = (kind === 'grn' ? m.grnIds : m.srnIds) || [], L = kind.toUpperCase(), OKS = kind === 'grn' ? GRN_OK : SRN_OK;
  const recs = ids.map(id => kind === 'grn' ? getGRN(id) : getSRN(id)).filter(Boolean);
  const live = recs.filter(r => !r.reversed && r.status !== 'Rejected'), pending = live.filter(r => !OKS.includes(r.status)), good = live.filter(r => OKS.includes(r.status));
  const ok = good.length > 0 && !pending.length, waiting = kind === 'grn' ? 'Pending Inspection' : 'Pending Acceptance';
  const reason = ok ? '' : !recs.length ? `an accepted ${L} is required — none linked yet` : !live.length ? `every linked ${L} was rejected or reversed — link a valid ${L}` : `${pending.map(r => r.number).join(', ')} ${kind === 'grn' ? 'is still pending inspection' : 'is still pending acceptance'}`;
  return { key: kind, ok, status: ok ? 'Accepted' : !recs.length ? 'None' : pending.length ? waiting : 'Rejected', title: `Accepted ${L}`, recs, reason };
}
function msGate(m, po) {
  const conds = [], sl = sliceInfo(m, po);
  if (m.needsDoc) {
    const st = docState(m), t = docTitleOf(m);
    conds.push({ key: 'doc', ok: st === 'Approved', status: st, title: t,
      reason: st === 'Approved' ? '' : st === 'Not Uploaded' ? `the ${t} has not been uploaded yet` : st === 'Rejected' ? `the ${t} was rejected${m.doc.rejectReason ? ' (' + m.doc.rejectReason + ')' : ''} — upload a corrected document` : `the ${t} is uploaded and awaiting approval` });
  }
  const gc = m.needsGuarantee ? guaranteeCond(m.guarantee, m.guaranteeTitle || 'Bank guarantee') : null; if (gc) conds.push(gc);
  if (m.trigger && m.trigger.lineId && lineOf(po, m.trigger.lineId)) { const l = lineOf(po, m.trigger.lineId), c = lineCum(po, l.id, m.trigger.qty), ok = c.cum >= m.trigger.qty - EPS;
    conds.push({ key: 'trigger', ok, status: ok ? 'Accepted' : c.cum > 0 ? 'Partially Accepted' : 'None', title: 'Quantity trigger', recs: [], line: l, need: +m.trigger.qty, cum: c.cum, firedBy: c.firedBy, surplus: c.surplus,
      reason: `L${l.no} cumulative accepted quantity is ${fq(c.cum)} of ${fq(m.trigger.qty)} ${l.uom} — it fires when the line reaches ${fq(m.trigger.qty)}` }); }
  const qG = sl.filter(x => x.kind === 'Goods' && x.basis === 'quantity'), nG = sl.filter(x => x.kind === 'Goods' && x.basis !== 'quantity');
  const qS = sl.filter(x => x.kind === 'Services' && x.basis === 'quantity'), nS = sl.filter(x => x.kind === 'Services' && x.basis !== 'quantity');
  if (m.needsGrn && !(qG.length && !nG.length)) conds.push(recCond(m, 'grn'));
  if (m.needsSrn && !(qS.length && !nS.length)) conds.push(recCond(m, 'srn'));
  const qs = [...qG, ...qS];
  if (qs.length) {
    const need = sum(qs, x => x.value), got = sum(qs, x => x.ent);
    conds.push({ key: 'qty', soft: true, ok: got >= need - EPS, status: got >= need - EPS ? 'Accepted' : got > EPS ? 'Partially Accepted' : 'None', title: 'Accepted quantity', recs: [...(m.grnIds || []).map(getGRN), ...(m.srnIds || []).map(getSRN)].filter(Boolean),
      reason: `${money(got)} of ${money(need)} of the scoped quantity is accepted` });
    if (m.requireCompleteQty) {
      const short = qs.filter(x => x.ent < x.value - EPS);
      conds.push({ key: 'complete', ok: !short.length, status: short.length ? 'Incomplete' : 'Accepted', title: 'Complete quantity', recs: [],
        reason: short.length ? `all scoped quantity must be accepted before this milestone is billable — ${short.map(x => x.kind === 'Goods' ? `${fq((x.value - x.ent) / x.line.price)} of ${fq(x.s.qty)} ${x.line.uom} of ${x.line.desc} still to accept` : `${money(x.value - x.ent)} of ${x.line.desc} still to accept`).join('; ')}` : '' });
    }
  }
  const hard = conds.filter(c => !c.soft), unmet = hard.filter(c => !c.ok), recs = conds.flatMap(c => c.recs || []);
  const label = [m.needsGrn || qG.length ? 'GRN' : '', m.needsSrn || qS.length ? 'SRN' : ''].filter(Boolean).join(' + ') || recLabel(po);
  return { ok: !unmet.length, required: conds.length > 0, label, recs, rec: recs[0], conds, reason: unmet.map(c => c.reason).join(' and ') };
}
/* Eligible value = approved + every hard gate passed → the sum of the slice entitlements (quantity slices count accepted units only) */
function msEnt(m, po) { if (m.status !== 'Approved') return 0; if (!msGate(m, po).ok) return 0; return r2(sum(sliceInfo(m, po), x => x.ent)); }
function msBilling(m, po) {
  const u = usage('milestone', m.id), ent = msEnt(m, po);
  if (u.value >= m.amount - EPS && m.amount > 0) return 'Invoiced';
  if (u.value > EPS) return ent > 0 ? 'Partially Invoiced' : 'Not Eligible';
  return ent > 0 ? 'Eligible' : 'Not Eligible';
}
/* value already billed on each slice: explicit per-line allocations first, the rest served in scope order */
function sliceRemaining(m, po, exInv) {
  const sl = sliceInfo(m, po), used = new Array(sl.length).fill(0), al = allocsOn('milestone', m.id, exInv);
  let rest = 0;
  al.forEach(({ a }) => { if (a.lines && a.lines.length) a.lines.forEach(x => { const i = sl.findIndex(y => y.line.id === x.lineId); if (i >= 0) used[i] = r2(used[i] + x.value); else rest = r2(rest + x.value); }); else rest = r2(rest + a.value); });
  sl.forEach((x, i) => { if (rest > EPS) { const t = Math.min(rest, Math.max(0, x.ent - used[i])); used[i] = r2(used[i] + t); rest = r2(rest - t); } });
  return sl.map((x, i) => ({ ...x, used: used[i], remaining: r2(Math.max(0, x.ent - used[i])) }));
}
/* ===== dependencies & timing (brief §1–2, D01–D06, D18–D20) =====
   A dependency does ONE of three separate things (its "effect"): derive a DATE (schedule), BLOCK billing (gate), or both.
   A late planned date never blocks billing by itself — only a gate does.  Relation FS = finish→start, SS = start→start, FF = finish→finish. */
const DEP_TYPES = { FS: 'Finish → Start', SS: 'Start → Start', FF: 'Finish → Finish' };
const DEP_EFFECTS = { schedule: 'Schedule only', gate: 'Gate only', both: 'Schedule + gate' };
const DEP_STATES = { approved: 'Approved', invoiced: 'Invoiced', paid: 'Paid' };
const dpAdd = (iso, n) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + Math.round(+n || 0)); return d.toISOString().slice(0, 10); };
const dpDiff = (a, b) => (a && b) ? Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5) : 0;
const normDep = d => ({ pred: d.pred, type: DEP_TYPES[d.type] ? d.type : 'FS', lag: Math.round(+d.lag || 0), effect: DEP_EFFECTS[d.effect] ? d.effect : 'schedule', state: DEP_STATES[d.state] ? d.state : 'approved', legacy: !!d.legacy });
/* explicit dependency rows win; an old plain "depends on M2" list reads as FS · lag 0 · schedule, "invoiced" (gated only when the PO enforces dependencies) */
const depList = m => (Array.isArray(m.deps) ? m.deps : (m.dependsOn || []).map(c => ({ pred: c, legacy: true, state: 'invoiced', effect: 'schedule' }))).filter(d => d && d.pred).map(normDep);
const depCodes = m => depList(m).map(d => d.pred);
const depsOf = (m, po) => depCodes(m).map(c => msOf(po).find(x => x.code === c)).filter(Boolean);
const depJoin = m => m.depJoin === 'ANY' ? 'ANY' : 'ALL';
/* pure schedule solver over draft or stored milestones: planned → forecast → actual (D01–D03, case 1/2).
   item = { code, planned, durationDays, forecast, actualStart, actualFinish, deps, gone? } */
function computeDates(list) {
  const by = {}; list.forEach(x => { by[x.code] = x; }); const memoP = {}, memoE = {}, stk = new Set();
  const dur = x => Math.max(0, Math.round(+x.durationDays || 0));
  const solve = (code, eff) => {
    const memo = eff ? memoE : memoP, x = by[code]; if (!x) return null; if (memo[code]) return memo[code];
    if (stk.has(eff + code)) return { start: x.planned || '', finish: x.planned || '', cycle: true };
    stk.add(eff + code);
    let cs = '', cf = '', driver = '';
    depList(x).filter(d => d.effect !== 'gate' || d.legacy).forEach(d => { const p = solve(d.pred, eff); if (!p || p.cycle) return;
      if (d.type === 'SS' && p.start) { const e = dpAdd(p.start, d.lag); if (e > cs) { cs = e; driver = d.pred; } }
      else if (d.type === 'FS' && p.finish) { const e = dpAdd(p.finish, d.lag); if (e > cs) { cs = e; driver = d.pred; } }
      else if (d.type === 'FF' && p.finish) { const e = dpAdd(p.finish, d.lag); if (e > cf) { cf = e; driver = d.pred; } } });
    const n = dur(x); let finish, start, source;
    if (!eff) { finish = x.planned || (cs ? dpAdd(cs, n) : '') || cf; if (cf && finish < cf) finish = cf; start = finish ? dpAdd(finish, -n) : ''; source = x.planned ? 'planned' : (finish ? 'derived' : ''); }
    else {
      const base = x.forecast || solve(code, false).finish;
      if (x.actualFinish) { finish = x.actualFinish; start = x.actualStart || dpAdd(finish, -n); source = 'actual'; }
      else { finish = base; if (cs && finish < dpAdd(cs, n)) finish = dpAdd(cs, n); if (cf && finish < cf) finish = cf;
        start = x.actualStart || (finish ? dpAdd(finish, -n) : ''); if (x.actualStart && finish && finish < dpAdd(x.actualStart, n)) finish = dpAdd(x.actualStart, n);
        source = x.actualStart ? 'actual start' : (x.forecast || (finish && finish !== base) ? 'forecast' : 'planned'); }
    }
    stk.delete(eff + code); return (memo[code] = { start, finish, source, driver });
  };
  const out = {}; list.forEach(x => { const p = solve(x.code, false), e = solve(x.code, true);
    out[x.code] = { plannedStart: p.start, plannedFinish: p.finish, start: e.start, finish: e.finish, source: e.source, driver: e.driver, slip: (p.finish && e.finish) ? dpDiff(p.finish, e.finish) : 0, cycle: !!(p.cycle || e.cycle) }; });
  return out;
}
/* D19: a cycle blocks the save; returns the loop as ['M2','M3','M2'] or null */
function depCycle(list) {
  const by = {}; list.forEach(x => { by[x.code] = x; }); const state = {}, path = [];
  const dfs = c => { if (state[c] === 2) return null; if (state[c] === 1) return [...path.slice(path.indexOf(c)), c]; state[c] = 1; path.push(c);
    for (const d of depList(by[c] || {})) { if (by[d.pred]) { const r = dfs(d.pred); if (r) return r; } }
    path.pop(); state[c] = 2; return null; };
  for (const x of list) { const r = dfs(x.code); if (r) return r.reverse(); } return null;
}
/* D19 warning (never blocks): the successor is dated before its predecessor allows */
function depWarnings(list) {
  const out = [], by = {}; list.forEach(x => { by[x.code] = x; }); const pl = computeDates(list.map(x => ({ ...x, planned: x.planned })));
  list.forEach(x => depList(x).forEach(d => { const p = by[d.pred]; if (!p) return; const P = pl[d.pred], S = pl[x.code]; if (!P || !S || !x.planned) return;
    const need = d.type === 'SS' ? dpAdd(P.plannedStart, d.lag) : dpAdd(P.plannedFinish, d.lag), have = d.type === 'FF' ? S.plannedFinish : S.plannedStart;
    if (need && have && have < need) out.push(`${x.code} is dated ${fmtD(have)} but ${d.pred} (${DEP_TYPES[d.type]}${d.lag ? `, ${d.lag > 0 ? '+' : ''}${d.lag}d` : ''}) allows it only from ${fmtD(need)}.`); })); return out;
}
const msDateItem = (m, po) => ({ code: m.code, planned: m.planned || '', durationDays: m.durationDays || 0, forecast: m.forecastDate || '', deps: depList(m),
  actualStart: m.startedAt ? String(m.startedAt).slice(0, 10) : '', actualFinish: m.status === 'Approved' && m.approvedAt ? String(m.approvedAt).slice(0, 10) : '' });
const msDates = po => { const l = msOf(po); const r = computeDates(l.map(m => msDateItem(m, po))); return r; };
const msDate = (m, po) => msDates(po)[m.code] || {};
/* D18: what moves downstream if the given milestone items are changed — a preview before the amendment is applied */
function depImpact(before, after, po) {
  const a = computeDates(before), b = computeDates(after), out = [];
  after.forEach(x => { const o = a[x.code], n = b[x.code]; if (!o || !n || o.finish === n.finish) return;
    const m = po && msOf(po).find(q => q.code === x.code), frozen = !!(m && usage('milestone', m.id).value > EPS);
    out.push({ code: x.code, from: o.finish, to: n.finish, days: dpDiff(o.finish, n.finish), frozen }); }); return out;
}
/* has predecessor `d.pred` reached the dependency's state?  (D05) + the date it reached it on */
function depReached(d, pred, po) {
  if (!pred) return { ok: false, gone: true, date: '' };
  const inv = usage('milestone', pred.id).invs.filter(i => APPROVED.includes(i.status) || i.status === 'Paid');
  if (d.type === 'SS') return { ok: !['Draft', 'Pending'].includes(pred.status), date: pred.startedAt ? String(pred.startedAt).slice(0, 10) : (pred.approvedAt ? String(pred.approvedAt).slice(0, 10) : '') };
  if (d.state === 'approved') return { ok: pred.status === 'Approved', date: pred.approvedAt ? String(pred.approvedAt).slice(0, 10) : '' };
  const billed = msBilling(pred, po) === 'Invoiced';
  if (d.state === 'invoiced') return { ok: billed, date: inv.map(i => i.date).sort().pop() || '' };
  const paid = billed && usage('milestone', pred.id).invs.length > 0 && usage('milestone', pred.id).invs.every(i => i.status === 'Paid');
  return { ok: paid, date: usage('milestone', pred.id).invs.map(i => i.ap && i.ap.paidAt ? String(i.ap.paidAt).slice(0, 10) : '').sort().pop() || '' };
}
/* gate evaluation per phase: FS gates billing, SS gates starting, FF gates approval; an old "enforce dependencies" PO gates every dependency on approval and billing.
   Negative lag lets the successor go ahead before the predecessor finishes (overlap) once forecast + lag has passed. Join ALL / ANY (D04). */
function depGate(m, po, phase) {
  const enforce = !!poCfg(po).enforceDependencies, all = msOf(po), dates = msDates(po), rows = [];
  depList(m).forEach(d => {
    const typed = (phase === 'start' && d.type === 'SS') || (phase === 'approve' && d.type === 'FF') || (phase === 'bill' && d.type === 'FS');
    const legacyEnf = enforce && (phase === 'approve' || phase === 'bill') && d.type === 'FS' && d.legacy;
    const gated = d.effect !== 'schedule' || (enforce && !d.legacy);
    if (!((typed && gated) || legacyEnf)) return;
    const pred = all.find(x => x.code === d.pred), r = depReached(d, pred, po), today = todayISO();
    let ok = false, why = '';
    if (!pred) why = `${d.pred} no longer exists (cancelled or replaced) — point ${m.code} at another milestone or remove the dependency`;
    else if (r.ok) { const due = r.date && d.lag > 0 ? dpAdd(r.date, d.lag) : ''; if (due && today < due) why = `${d.pred} ${d.type === 'SS' ? 'started' : d.state} ${fmtD(r.date)} + ${d.lag} days — opens ${fmtD(due)}`; else ok = true; }
    else if (d.lag < 0 && dates[d.pred] && dates[d.pred].finish && today >= dpAdd(dates[d.pred].finish, d.lag)) ok = true;           // overlap
    else why = `${d.pred} is not ${d.type === 'SS' ? 'started' : d.state} yet${d.lag < 0 ? ` (may overlap from ${fmtD(dpAdd((dates[d.pred] || {}).finish || '', d.lag))})` : ''}`;
    rows.push({ dep: d, code: d.pred, ok, why, name: pred ? pred.name : '' });
  });
  const ok = !rows.length || (depJoin(m) === 'ANY' ? rows.some(r => r.ok) : rows.every(r => r.ok));
  return { ok, rows, unmet: ok ? [] : rows.filter(r => !r.ok), join: depJoin(m) };
}
/* what blocks `m` right now at `phase`, as [{code, why}] — empty when nothing does */
const unmetDeps = (m, po, phase = 'bill') => depGate(m, po, phase).unmet;
const depMsg = (m, un, join) => `${m.code} depends on ${un.map(u => u.code).join(join === 'ANY' ? ' or ' : ', ')}: ${un.map(u => u.why).join('; ')}${join === 'ANY' && un.length > 1 ? ' (any one of them is enough)' : ''}`;
/* D06: the closing milestone cannot be approved before the rest of the schedule is done and every receipt has been inspected */
function closingBlock(m, po) {
  if (!m.closing) return '';
  const others = msOf(po).filter(x => x.id !== m.id && !['Approved'].includes(x.status));
  if (others.length) return `${m.code} closes the PO — it cannot be approved until ${others.map(x => x.code).join(', ')} ${others.length > 1 ? 'are' : 'is'} approved.`;
  const pend = [...db.grns.filter(g => g.poId === po.id && g.status === 'Pending Inspection'), ...db.srns.filter(s => s.poId === po.id && s.status === 'Pending Acceptance')];
  if (pend.length) return `${m.code} closes the PO — ${pend.map(x => x.number).join(', ')} still await${pend.length > 1 ? '' : 's'} inspection; every receipt must be complete first.`;
  return '';
}
/* D10/D11/case 2: invoice due = the later of (receipt, acceptance) + m days; the basis and days are set per PO (default by contract category) */
const DUE_DAYS_BY_CATEGORY = { 'Machinery & Equipment': 45, 'Services': 30, 'IT': 30 };
function dueTerms(po) { const c = poCfg(po); return { basis: ['later', 'receipt', 'acceptance'].includes(c.dueBasis) ? c.dueBasis : 'later', days: +c.dueDays > 0 ? +c.dueDays : (DUE_DAYS_BY_CATEGORY[po.category] || 30) }; }
function invoiceDue(po, received, accepted) {
  const t = dueTerms(po), base = t.basis === 'receipt' ? received : t.basis === 'acceptance' ? (accepted || received) : ((accepted || '') > received ? accepted : received);
  return { date: dpAdd(base, t.days), days: t.days, basis: t.basis, base };
}
/* PO line unit conversions: { Box: 12 } = 1 Box is 12 of the line's unit */
const parseConvs = t => { const o = {}; String(t || '').split(/[,;\n]/).forEach(p => { const m = p.match(/^\s*(?:1\s*)?([^=]+?)\s*=\s*([\d.]+)/); if (m) o[m[1].trim()] = +m[2]; }); return o; };
const convsStr = c => Object.entries(c || {}).map(([k, v]) => `${k}=${v}`).join(', ');
const normConvs = c => { if (typeof c === 'string') c = parseConvs(c); const o = {}; Object.entries(c || {}).forEach(([k, v]) => { if (k && +v > 0) o[String(k)] = +v; }); return o; };
/* a cumulative-quantity trigger needs a goods line, a threshold within the line quantity, and a quantity slice of that line in the milestone's own scope */
function trigErrors(lines, m, code) {
  const t = m.trigger; if (!t || !t.lineId) return [];
  const l = lines.find(x => x.id === t.lineId), out = [];
  if (!l) return [`${code}: the trigger refers to a line that does not exist.`];
  const n = lines.indexOf(l) + 1;
  if (isOutside(l)) out.push(`${code}: L${n} is billed outside the schedule — it cannot carry a quantity trigger.`);
  if (l.kind === 'Services') out.push(`${code}: a quantity trigger counts goods received (GRN) — L${n} is a services line.`);
  if (!(+t.qty > 0)) out.push(`${code}: the trigger quantity must be greater than zero.`);
  else if (+t.qty > +l.qty + EPS) out.push(`${code}: trigger ${fq(+t.qty)} is more than the ${fq(l.qty)} ${l.uom} on L${n}.`);
  if (!explicitScope(m) || !(m.scope || []).some(x => x.lineId === t.lineId && x.basis === 'quantity')) out.push(`${code}: a quantity trigger needs a quantity row for that line in the milestone's scope (the trigger decides when to bill; the scope decides what).`);
  return out;
}
/* delay damages: a rate per week or part of a week late, capped, both as % of the milestone value */
const normDamages = d => d && +d.ratePct > 0 ? { ratePct: +d.ratePct, capPct: +d.capPct > 0 ? +d.capPct : 10 } : null;
/* lateness of a milestone against its (possibly extended) due date, using the completion date the supplier reported */
function msDelay(m) {
  if (!m.planned || !m.actualDate || m.actualDate <= m.planned) return { days: 0, weeks: 0 };
  const days = dpDiff(m.planned, m.actualDate); return { days, weeks: Math.ceil(days / 7) };
}
function damagesFor(m, value) {
  const d = m.damages, dl = msDelay(m); if (!d || !dl.days) return null;
  const pct = Math.min(d.capPct, r2(dl.weeks * d.ratePct)), amount = r2(value * pct / 100);
  return amount > 0 ? { msId: m.id, code: m.code, name: m.name, lateDays: dl.days, weeks: dl.weeks, ratePct: d.ratePct, capPct: d.capPct, pct, capped: dl.weeks * d.ratePct > d.capPct, base: value, amount } : null;
}
function computeDamages(inv) {
  const items = (inv.allocs || []).filter(a => a.kind === 'milestone').map(a => { const m = getMS(a.refId); return m ? damagesFor(m, a.value) : null; }).filter(Boolean);
  return { items, total: r2(sum(items, x => x.amount)) };
}
const damagesCash = i => i && i.damages ? r2(i.damages.total || 0) : 0;
/* the stored timing / dependency fields of a milestone; `dependsOn` (codes) is kept in step for older screens */
function depFields(m) {
  const explicit = Array.isArray(m.deps), deps = depList(m).map(d => explicit || !d.legacy ? { pred: d.pred, type: d.type, lag: d.lag, effect: d.effect, state: d.state } : null).filter(Boolean);
  return { ...(explicit ? { deps } : {}), dependsOn: depList(m).map(d => d.pred), measured: !!m.measured, trigger: m.trigger && m.trigger.lineId && +m.trigger.qty > 0 ? { lineId: m.trigger.lineId, qty: +m.trigger.qty } : null, damages: normDamages(m.damages), depJoin: m.depJoin === 'ANY' ? 'ANY' : 'ALL', durationDays: Math.max(0, Math.round(+m.durationDays || 0)), forecastDate: m.forecastDate || '', closing: !!m.closing };
}
/* builds the stored milestone from a draft definition + the derived schedule (amount, slice values) */
const normAdvance = a => { a = a || {}; return { allowed: !!a.allowed, mode: a.mode === 'amount' ? 'amount' : 'percent', value: +a.value || 0, recovery: a.recovery === 'first' ? 'first' : 'proportional', guaranteeRequired: !!a.guaranteeRequired, guaranteeTitle: a.guaranteeRequired ? (String(a.guaranteeTitle || '').trim() || 'Advance payment guarantee') : '' }; };
function makeMilestone(po, m, i, sch, extra = {}) {
  const scope = sch.scopes[i].map((x, si) => ({ ...x, value: sch.values[i][si] }));
  const qG = scope.some(x => x.basis === 'quantity' && lineKind(po, lineOf(po, x.lineId) || {}) === 'Goods'), qS = scope.some(x => x.basis === 'quantity' && lineKind(po, lineOf(po, x.lineId) || {}) === 'Services');
  return { id: m.id || uid('ms'), poId: po.id, seq: i + 1, code: `M${i + 1}`, name: String(m.name).trim(), pct: explicitScope(m) ? sch.pcts[i] : +m.pct, amount: sch.amounts[i], planned: m.planned || '', simple: !explicitScope(m), scope,
    status: 'Draft', needsDoc: !!m.needsDoc, docTitle: m.needsDoc ? (String(m.docTitle || '').trim() || 'Supporting document') : '', docApproverRole: m.docApproverRole || 'owner',
    needsGrn: !!m.needsGrn || qG, needsSrn: !!m.needsSrn || qS, allowPartial: !!m.allowPartial, requireCompleteQty: !!m.requireCompleteQty, autoSrn: !!m.autoSrn,
    needsGuarantee: !!m.needsGuarantee, guaranteeTitle: m.needsGuarantee ? (String(m.guaranteeTitle || '').trim() || 'Performance bank guarantee') : '', guarantee: null,
    ...depFields(m), advance: normAdvance(m.advance), doc: null, grnIds: [], srnIds: [], submissions: [], history: [], evidence: [], remarks: '', actualDate: '', approvedAt: '', rejectReason: '', ...extra };
}
/* gaps = lines whose scope no longer reconciles (e.g. a PO quantity was amended): the schedule "reopens" until the difference is assigned */
function scheduleGaps(po) {
  const out = [], ms = msOf(po), lbl = l => `L${l.no} (${String(l.desc).slice(0, 40)})`;
  po.lines.filter(l => !isOutside(l)).forEach(l => {
    const sl = ms.flatMap(m => (m.scope || []).filter(x => x.lineId === l.id));
    if (!sl.length) { out.push(`${lbl(l)} is not assigned to any milestone.`); return; }
    const b = sl[0].basis, assigned = sum(sl, x => b === 'quantity' ? x.qty : b === 'percent' ? x.percent : x.amount), total = b === 'quantity' ? l.qty : b === 'percent' ? 100 : lineNet(l), diff = r2(total - assigned), u = b === 'quantity' ? ' ' + l.uom : b === 'percent' ? '%' : ' INR';
    if (Math.abs(diff) > (b === 'percent' ? 1e-6 : EPS)) out.push(diff > 0 ? `${lbl(l)} has ${qtyOf(diff, total, b === 'quantity' ? l.uom : b === 'percent' ? '%' : 'INR')} not assigned to any milestone. Assign them, or mark the line as billed outside the schedule.` : `${lbl(l)} is assigned ${qtyOf(assigned, total, b === 'quantity' ? l.uom : b === 'percent' ? '%' : 'INR')}. Reduce the scope on a milestone by ${fq(-diff)}${u}.`);
  });
  return out;
}

/* percentage schedule → amounts; the last milestone absorbs rounding so the schedule always equals the billing base */
function milestoneAmounts(ms, poValue) {
  let used = 0;
  return ms.map((m, i) => { const a = i === ms.length - 1 ? r2(poValue - used) : r2((Number(m.pct) || 0) * poValue / 100); used = r2(used + a); return a; });
}
function scheduleCheck(ms, poValue) {
  const errs = [], pctTotal = r2(ms.reduce((s, m) => s + (Number(m.pct) || 0), 0));
  const amounts = Math.abs(pctTotal - 100) < 0.0001 ? milestoneAmounts(ms, poValue) : ms.map(m => r2((Number(m.pct) || 0) * poValue / 100));
  if (!ms.length) errs.push('Add at least one milestone.');
  if (!(poValue > 0)) errs.push(`PO value is ${money(0)} — enter the line items before building the schedule.`);
  ms.forEach((m, i) => { const c = m.code || 'M' + (i + 1); if (!String(m.name || '').trim()) errs.push(`${c}: milestone name is required.`); if (!(Number(m.pct) > 0)) errs.push(`${c}: percentage must be greater than zero.`); });
  if (ms.length && Math.abs(pctTotal - 100) > 0.0001) errs.push(pctTotal > 100 ? `Schedule totals ${fmtNum(pctTotal)}% — it exceeds the PO value by ${fmtNum(r2(pctTotal - 100))}%.` : `Schedule totals ${fmtNum(pctTotal)}% — ${fmtNum(r2(100 - pctTotal))}% of the PO value is not allocated yet. It must total exactly 100%.`);
  return { pctTotal, total: sum(amounts, x => x), amounts, errors: errs, ok: !errs.length };
}

/* ---------- certified progress claims (Services, PO level) ---------- */
const cumCertified = (po, exId) => sum(claimsOf(po).filter(c => c.status === 'Certified' && c.id !== exId), c => c.certified);
function claimView(c) {
  const po = getPO(c.poId);
  const prev = c.status === 'Certified' ? c.prevCum : cumCertified(po, c.id);
  const current = r2(c.claimedCum - prev);
  const u = usage('claim', c.id);
  const ent = c.status === 'Certified' ? c.certified : 0;
  return { prev, current, cum: c.claimedCum, certified: c.status === 'Certified' ? c.certified : 0, used: u.value, remaining: r2(Math.max(0, ent - u.value)), ent };
}

/* ---------- eligible sources (entitlements) for a PO ---------- */
function receiptItems(po, ex, only) {
  const items = [];
  if (hasGoods(po)) grnsOf(po).filter(g => only(g.lineId)).forEach(g => {
    const line = lineOf(po, g.lineId), ent = grnEnt(g), u = usage('grn', g.id, ex), price = line.price;
    let reason = '';
    if (g.reversed) reason = 'Receipt reversed — entitlement withdrawn';
    else if (g.status === 'Rejected') reason = 'GRN rejected — nothing invoice-eligible';
    else if (!GRN_OK.includes(g.status)) reason = `GRN is ${g.status} — not invoice-eligible until accepted`;
    else if (ent - u.qty <= EPS) reason = `Fully allocated${u.invs.length ? ' on ' + u.invs.map(invRef).join(', ') : ''}`;
    const availQty = r2(Math.max(0, ent - u.qty));
    items.push({ kind: 'grn', refId: g.id, ref: g, label: g.number, name: `${g.number} · ${fmtD(g.date)}`, line, status: g.reversed ? 'Reversed' : g.status, price, entQty: ent, entValue: r2(ent * price), usedQty: u.qty, usedValue: r2(u.qty * price),
      committedQty: u.committedQty, reservedQty: u.reservedQty, committedValue: r2(u.committedQty * price), reservedValue: r2(u.reservedQty * price),
      availQty, availValue: r2(availQty * price), eligible: availQty > EPS, reason, invs: u.invs });
  });
  if (hasServices(po)) srnsOf(po).filter(x => only(x.lineId)).forEach(x => {
    const line = lineOf(po, x.lineId), ent = srnEnt(x), u = usage('srn', x.id, ex);
    let reason = '';
    if (x.reversed) reason = 'Receipt reversed — entitlement withdrawn';
    else if (x.status === 'Rejected') reason = 'SRN rejected — nothing invoice-eligible';
    else if (!SRN_OK.includes(x.status)) reason = `SRN is ${x.status} — not invoice-eligible until accepted`;
    else if (ent - u.value <= EPS) reason = `Fully allocated${u.invs.length ? ' on ' + u.invs.map(invRef).join(', ') : ''}`;
    items.push({ kind: 'srn', refId: x.id, ref: x, label: x.number, name: `${x.number} · ${fmtD(x.date)}`, line, status: x.reversed ? 'Reversed' : x.status, entQty: null, entValue: ent, usedQty: 0, usedValue: u.value, committedValue: u.committedValue, reservedValue: u.reservedValue,
      availQty: null, availValue: r2(Math.max(0, ent - u.value)), eligible: ent > 0 && ent - u.value > EPS, reason, invs: u.invs });
  });
  return items;
}
function sourceItems(po, ex) {
  const items = [];
  if (po.billingMethod === 'Milestone') {
    msOf(po).forEach(m => {
      const gate = msGate(m, po), ent = msEnt(m, po), u = usage('milestone', m.id, ex), dep = unmetDeps(m, po, 'bill');
      let reason = '', hold = false;
      if (m.status === 'Draft') reason = 'PO is not approved yet';
      else if (m.status === 'Pending') reason = 'Milestone work has not started';
      else if (m.status === 'In Progress') reason = 'Milestone is in progress — not submitted for approval yet';
      else if (m.status === 'Submitted for Approval') reason = 'Submitted — waiting for the approver to review';
      else if (m.status === 'Under Review') reason = 'Under review by the approver';
      else if (m.status === 'Rejected') reason = `Rejected${m.rejectReason ? ' (' + m.rejectReason + ')' : ''} — the supplier must resubmit`;
      else if (!gate.ok) reason = `Approved, but ${gate.reason}`;
      else if (u.value >= m.amount - EPS) reason = `Fully invoiced${u.invs.length ? ' on ' + u.invs.map(invRef).join(', ') : ''}`;
      else if (dep.length) { reason = depMsg(m, dep, depJoin(m)); hold = true; }
      else if (!m.allowPartial && ent < m.amount - EPS) { reason = `Only ${money(ent)} of ${money(m.amount)} is accepted so far — without partial invoicing this milestone is billed once, in full`; hold = true; }
      items.push({ kind: 'milestone', refId: m.id, ref: m, label: m.code, name: m.name, status: m.status, entQty: null, entValue: ent, usedQty: 0, usedValue: u.value, committedValue: u.committedValue, reservedValue: u.reservedValue,
        availQty: null, availValue: r2(Math.max(0, ent - u.value)), eligible: ent > 0 && ent - u.value > EPS && !hold, reason, invs: u.invs });
    });
    items.push(...receiptItems(po, ex, id => { const l = lineOf(po, id); return l && isOutside(l); }));          // lines billed outside the schedule bill on accepted receipts
    items.push(...advSourceItems(po, ex));
    return items;
  }
  if (poCertified(po)) {
    claimsOf(po).forEach(c => {
      const v = claimView(c), u = usage('claim', c.id, ex);
      let reason = '';
      if (c.status !== 'Certified') reason = `Claim is ${c.status} — not yet certified`;
      else if (u.value >= v.certified - EPS) reason = `Fully invoiced${u.invs.length ? ' on ' + u.invs.map(invRef).join(', ') : ''}`;
      items.push({ kind: 'claim', refId: c.id, ref: c, label: c.number, name: `Claim ${c.period}`, status: c.status, entQty: null, entValue: v.ent, usedQty: 0, usedValue: u.value, committedValue: u.committedValue, reservedValue: u.reservedValue,
        availQty: null, availValue: r2(Math.max(0, v.ent - u.value)), eligible: v.ent > 0 && v.ent - u.value > EPS, reason, invs: u.invs });
    });
    return items;
  }
  return receiptItems(po, ex, () => true);
}

/* ---------- PO summary: received / accepted / invoiced / approved / paid are distinct ---------- */
function poSummary(po) {
  const value = poNet(po), invs = invsOf(po).filter(i => !i.reversed && !i.advanceId), live = invs.filter(isLive);       // advance invoices are tracked separately (they are consumption, not billing)
  const items = sourceItems(po).filter(x => x.kind !== 'advance');
  const invoiced = sum(live, i => i.net);
  const approved = sum(invs.filter(i => APPROVED.includes(i.status)), i => i.net);
  const paid = sum(invs.filter(i => i.status === 'Paid'), i => i.net);
  const reserved = sum(live.filter(i => !APPROVED.includes(i.status)), i => i.net);
  const advOut = advOutstandingOf(po);
  let received = 0;
  if (po.billingMethod === 'Milestone') received = sum(msOf(po).filter(m => ['Submitted for Approval', 'Under Review', 'Approved'].includes(m.status)), m => m.amount);
  else if (poCertified(po)) received = sum(claimsOf(po).filter(c => ['Submitted', 'Certified'].includes(c.status)), c => claimView(c).current);
  else received = sum(grnsOf(po).filter(g => !g.reversed), g => g.received * lineOf(po, g.lineId).price) + sum(srnsOf(po), s => s.serviceValue);
  const accepted = sum(items.filter(x => x.kind !== 'advance'), x => x.entValue);
  const remaining = (po.billingMethod === 'Standard') ? r2(Math.max(0, accepted - invoiced)) : sum(items.filter(x => x.eligible || x.kind !== 'advance'), x => x.availValue);
  const gs = grnsOf(po);
  return {
    value, received, accepted, invoiced, approved, paid, reserved, remaining, advanceOutstanding: advOut, consumed: r2(invoiced + advOut), remainingPO: r2(value - invoiced - advOut),
    acceptedQty: sum(gs, grnEnt), receivedQty: sum(gs.filter(g => !g.reversed), g => g.received), rejectedQty: sum(gs.filter(g => !g.reversed), g => g.rejected),
    invoicedQty: sum(live.flatMap(i => i.allocs.filter(a => a.kind === 'grn')), a => a.qty),
    remainingPOQty: sum(goodsLines(po), l => lineReceiptStats(po, l).remaining),
    items,
  };
}

/* ---------- PO stage (drives the status pill and the stage tracker) ---------- */
function poStage(po) {
  const s = po.status === 'Approved' ? poSummary(po) : null;
  const recName = po.billingMethod === 'Milestone' ? 'Milestone' : poCertified(po) ? 'Progress' : recLabel(po);
  const steps = [
    { t: 'PO created', pending: 'Draft — not submitted', next: 'Submit the PO for approval' },
    { t: 'PO approved', pending: 'Approval Pending', next: 'Procurement Manager approves the PO' },
    { t: po.billingMethod === 'Milestone' ? 'Milestone approved' : poCertified(po) ? 'Progress certified' : isGoods(po) ? 'Goods received' : po.type === 'Mixed' ? 'Goods / service accepted' : 'Service accepted',
      pending: po.billingMethod === 'Milestone' ? 'Milestone Approval Pending' : poCertified(po) ? 'Progress Certification Pending' : isGoods(po) ? 'Goods Receipt Pending' : po.type === 'Mixed' ? 'Goods / Service Receipt Pending' : 'Service Receipt Pending',
      next: po.billingMethod === 'Milestone' ? 'Supplier submits a milestone with its evidence; the approver approves it' : poCertified(po) ? 'Vendor claims progress and buyer certifies it' : isGoods(po) ? 'Receive and accept goods from vendor' : po.type === 'Mixed' ? 'Receive and accept goods and services from vendor' : 'Receive and accept services from vendor' },
    { t: 'Invoice submitted', pending: 'Invoice Pending', next: 'Vendor submits an invoice for the eligible value' },
    { t: 'Invoice approved', pending: 'Invoice Approval Pending', next: 'AP Manager approves the invoice' },
    { t: 'Payment made', pending: 'Payment Pending', next: 'Post to AP and pay the vendor' },
  ];
  const reached = [po.status !== 'Draft' && po.status !== 'Rejected', po.status === 'Approved', !!s && s.accepted > EPS, !!s && s.invoiced > EPS, !!s && s.approved > EPS, !!s && s.paid > EPS];
  const complete = !!s && s.value > 0 && s.paid >= s.value - EPS;
  let cur = reached.findIndex(x => !x);
  let label, short, tone;
  if (po.status === 'Rejected') { label = 'Rejected'; short = 'REJECTED'; tone = 'red'; cur = 1; }
  else if (complete) { label = 'Completed'; short = 'CLOSED'; tone = 'gray'; cur = 6; }
  else if (cur === -1) { label = 'Billing in progress'; short = 'BILLING'; tone = 'green'; cur = 6; }
  else { label = steps[cur].pending; tone = po.status === 'Draft' ? 'gray' : po.status === 'Pending Approval' ? 'amber' : 'green';
    short = ['DRAFT', 'APPROVAL', recName.toUpperCase(), 'INVOICE', 'INV. APPROVAL', 'PAYMENT'][cur]; }
  const done = reached.filter(Boolean).length;
  return { steps, reached, cur, label, short, tone, complete, done, total: 6, next: steps[Math.min(cur, 5)].next, pctDone: Math.round((complete ? 6 : done) / 6 * 100) };
}
const poIsPast = po => po.status === 'Rejected' || poStage(po).complete;

/* ---------- invoice helpers ---------- */
const invRef = i => i.ref || i.id;
const approvalStatus = i => ({ 'Pending Approval': 'Pending', Approved: 'Approved', Posted: 'Approved', Paid: 'Approved', Rejected: 'Rejected', Cancelled: '—' }[i.status] || 'Not started');
const paymentStatus = i => ({ Paid: 'Paid', Posted: 'Awaiting payment', Approved: 'Not posted to AP' }[i.status] || '—');
const adjOf = i => db.adjustments.filter(a => a.invoiceId === i.id);
const payable = i => r2(i.gross - recoveryCash(i) - damagesCash(i) - (i.tdsDeducted || 0) - sum(adjOf(i).filter(a => a.type === 'Credit'), a => a.amount) + sum(adjOf(i).filter(a => a.type === 'Debit'), a => a.amount));
function buildInvoice(d) {
  const po = getPO(d.poId);
  const inv = { ...d };
  inv.allocs = (d.allocs || []).map(a => ({ ...a, value: r2(a.value) }));
  if (po && po.billingMethod !== 'Standard') inv.net = sum(inv.allocs, a => a.value);
  else inv.net = r2(d.net || 0);
  inv.gstRate = po ? gstOf(po) : GST_DEFAULT;
  const advA = inv.allocs.find(a => a.kind === 'advance'), adv = advA && getAdv(advA.refId);
  if (adv) { inv.advanceId = adv.id; inv.tdsDeducted = r2(adv.tds || 0); }
  inv.discountPct = Math.max(0, +d.discountPct || 0);
  inv.discount = r2(inv.net * inv.discountPct / 100);                 // discount is applied before tax; entitlement consumed stays the undiscounted net
  const taxable = r2(inv.net - inv.discount); let calc = (adv && poCfg(po).advanceGstMode === 'taxed_at_final') ? 0 : r2(taxable * inv.gstRate / 100);
  inv.taxMixed = false;                                               // I14: lines taxed at their own PO-line rate; the header is the sum of the lines
  if (po && !adv && inv.allocs.some(a => (a.lines || []).some(x => (x.gstRate != null && x.gstRate !== '') || (lineOf(po, x.lineId) || {}).gstRate != null))) {
    let g = 0; inv.taxMixed = true;
    inv.allocs.forEach(a => { if (a.lines && a.lines.length) a.lines.forEach(x => { const l = lineOf(po, x.lineId) || {}, rate = x.gstRate != null && x.gstRate !== '' ? +x.gstRate : (l.gstRate != null ? l.gstRate : inv.gstRate); g += (+x.value || 0) * (1 - inv.discountPct / 100) * rate / 100; }); else g += (+a.value || 0) * (1 - inv.discountPct / 100) * inv.gstRate / 100; });
    calc = r2(g);
  }
  inv.gstCalc = calc;
  inv.gst = (d.gstManual === null || d.gstManual === undefined || d.gstManual === '') ? calc : r2(d.gstManual);
  inv.tcs = r2(+d.tcs || 0); inv.roundOff = r2(+d.roundOff || 0);
  inv.gross = r2(taxable + inv.gst + inv.tcs + inv.roundOff);
  inv.recovery = computeRecoveries(inv);                              // advance recovery lines (negative) on milestone invoices
  inv.damages = computeDamages(inv);
  inv.dueSplit = invoiceDueSplit(po, inv);                            // I02: several milestones on one invoice → due per milestone, header = earliest                                  // delay damages (negative line, deducted from the payable)
  return inv;
}

/* ===== invoice linking (brief I01–I20) =====
   Every invoice line names a PO line and a milestone portion; consumption is an allocation record traceable down to the receipt line. */
/* I11 rate · I13 unit of measure · I14 tax · I09 quantity — checks on the supplier's own lines (a.lines) */
function lineLevelErrors(po, m, a, inv) {
  const out = [], sr = sliceRemaining(m, po, inv.id), tol = +poCfg(po).valueTolerancePct || 0;
  (a.lines || []).forEach(x => {
    const l = lineOf(po, x.lineId), sl = l && sr.find(y => y.line.id === x.lineId), nm = l ? `L${l.no} ${l.desc}` : String(x.lineId);
    if (!l || !sl) { out.push({ code: 'NO_SOURCE', msg: `${nm} is not in the scope of milestone ${m.code}.` }); return; }
    let qty = x.qty != null && x.qty !== '' ? +x.qty : null, rate = x.rate != null && x.rate !== '' ? +x.rate : null;
    if (qty != null && rate != null && Math.abs(r2(qty * rate) - r2(x.value)) > Math.max(1, r2(x.value * tol / 100))) out.push({ code: 'LINE', msg: `${nm}: ${fq(qty)} × ${money(rate)} = ${money(r2(qty * rate))}, but the line value is ${money(x.value)}.` });
    if (x.uom && x.uom !== l.uom) {                                              // I13: convert with the PO line factor — none means blocked
      const f = +((l.convs || {})[x.uom]);
      if (!(f > 0)) { out.push({ code: 'UOM', msg: `${nm}: invoiced in ${x.uom} but the PO line is in ${l.uom} and defines no conversion factor — blocked until the PO line gets one.` }); return; }
      if (qty != null) qty = r2(qty * f); if (rate != null) rate = r2(rate / f);
    }
    if (rate != null && l.price > 0 && Math.abs(rate - l.price) / l.price * 100 > tol + 1e-9) out.push({ code: 'RATE', msg: `${nm}: rate ${money(rate)} differs from the PO rate ${money(l.price)}${tol ? ` (tolerance ${tol}%)` : ''} — blocked; correct the invoice or amend the PO.` });
    if (qty != null && sl.kind === 'Goods' && sl.basis === 'quantity' && l.price > 0) { const rem = r2(sl.remaining / l.price); if (qty > rem + EPS) out.push({ code: 'OVER_QTY', msg: `${nm}: invoice quantity ${fq(qty)} ${l.uom} is above the accepted, unbilled quantity of ${fq(rem)} ${l.uom} on ${m.code}.` }); }
    if (x.gstRate != null && x.gstRate !== '') { const exp = l.gstRate != null ? l.gstRate : gstOf(po); if (+x.gstRate !== exp) out.push({ code: 'TAX', msg: `${nm}: taxed at ${x.gstRate}% but the PO line carries ${exp}%.` }); }
  });
  return out;
}
/* the receipts that can feed one portion, oldest acceptance first (I07); `prefer` lets the user put chosen receipts first before the invoice is submitted */
function receiptFeed(m, po, sl, prefer = []) {
  const line = sl.line, goods = sl.kind === 'Goods', pooled = goods && sl.basis === 'quantity' && poolLine(po, line.id);
  const src = goods ? (pooled ? db.grns.filter(g => g.poId === po.id && g.lineId === line.id) : (m.grnIds || []).map(getGRN).filter(g => g && g.lineId === line.id)) : (m.srnIds || []).map(getSRN).filter(q => q && q.lineId === line.id);
  const rank = r => { const i = prefer.indexOf(r.id); return i < 0 ? 999 : i; };
  const recs = src.map(r => { const share = pooled ? grnEnt(r) : recShare(m, r, goods ? 'grn' : 'srn'); return share > 0 ? { kind: goods ? 'grn' : 'srn', rec: r, date: r.date || '', left: goods ? r2(share * line.price) : share, units: goods } : null; }).filter(Boolean)
    .sort((a, b) => rank(a.rec) - rank(b.rec) || String(a.date).localeCompare(String(b.date)) || String(a.rec.number).localeCompare(String(b.rec.number)));
  if (pooled) { let prior = r2(sum(msOf(po).filter(q => (q.seq || 0) < (m.seq || 0)), q => sum((q.scope || []).filter(s => s.lineId === line.id && s.basis === 'quantity'), s => +s.qty || 0)) * line.price); recs.forEach(r => { const t = Math.min(prior, r.left); r.left = r2(r.left - t); prior = r2(prior - t); }); }
  return recs;
}
/* I05/I06/I07: trace each milestone allocation down to receipt lines. Receipts are consumed FIFO by acceptance date, replaying the milestone's earlier live invoices first, so the unused part of a receipt stays eligible. */
function allocTrace(inv) {
  const po = getPO(inv.poId), out = []; if (!po || po.billingMethod !== 'Milestone') return out;
  (inv.allocs || []).forEach(a => {
    if (a.kind !== 'milestone') return; const m = getMS(a.refId); if (!m) return;
    const pools = sliceInfo(m, po).map(sl => ({ sl, used: 0, recs: receiptFeed(m, po, sl, a.recOrder || []) }));
    const take = (p, v, rows) => { let rest = v; p.used = r2(p.used + v);
      p.recs.forEach(rc => { if (rest <= EPS || rc.left <= EPS) return; const t = Math.min(rest, rc.left); rc.left = r2(rc.left - t); rest = r2(rest - t);
        if (rows) rows.push({ kind: rc.kind, receipt: rc.rec.number, receiptId: rc.rec.id, date: rc.date, qty: rc.units ? r2(t / p.sl.line.price) : null, value: r2(t), partial: rc.left > EPS, left: rc.left }); });
      if (rest > EPS && rows) rows.push({ kind: null, receipt: null, date: m.approvedAt ? String(m.approvedAt).slice(0, 10) : '', qty: null, value: r2(rest), partial: false, left: 0 }); };
    const spread = (v) => { const parts = []; let rest = v; pools.forEach(p => { if (rest <= EPS) return; const cap = r2(Math.max(0, p.sl.ent - p.used)), t = Math.min(rest, cap); if (t > EPS) { parts.push({ p, v: r2(t) }); rest = r2(rest - t); } }); if (rest > EPS && pools.length) parts.push({ p: pools[pools.length - 1], v: r2(rest) }); return parts; };
    const parts = x => (x.lines && x.lines.length) ? x.lines.map(q => ({ p: pools.find(p => p.sl.line.id === q.lineId), v: +q.value })).filter(q => q.p) : spread(+x.value);
    db.invoices.filter(i => i.id !== inv.id && isLive(i) && (!inv.seq || (i.seq || 0) < inv.seq)).sort((x, y) => (x.seq || 0) - (y.seq || 0)).forEach(i => i.allocs.filter(q => q.kind === 'milestone' && q.refId === m.id).forEach(q => parts(q).forEach(z => take(z.p, z.v, null))));
    parts(a).forEach(z => { const rows = []; take(z.p, z.v, rows); rows.forEach(r => out.push({ allocId: a.id, refId: m.id, msCode: m.code, lineNo: z.p.sl.line.no, line: z.p.sl.line.desc, ...r })); });
  });
  return out;
}
/* I02: due dates per milestone (later of receipt and acceptance + the PO's due days); the header carries the earliest */
function invoiceDueSplit(po, inv) {
  const ms = (inv.allocs || []).filter(a => a.kind === 'milestone'); if (!po || ms.length < 2) return null;
  const rows = ms.map(a => { const m = getMS(a.refId); if (!m) return null; const dates = [m.approvedAt ? String(m.approvedAt).slice(0, 10) : '', ...[...(m.grnIds || []).map(getGRN), ...(m.srnIds || []).map(getSRN)].filter(Boolean).map(r => r.date || '')].filter(Boolean).sort();
    return { msId: m.id, code: m.code, amount: a.value, due: invoiceDue(po, inv.date || todayISO(), dates.pop() || '').date }; }).filter(Boolean);
  if (!rows.length) return null; const by = {}; rows.forEach(r => { by[r.due] = r2((by[r.due] || 0) + r.amount); });
  const split = Object.entries(by).sort(([x], [y]) => x.localeCompare(y)).map(([due, amount]) => ({ due, amount }));
  return { earliest: split[0].due, split, rows };
}
/* I18: a debit note on a milestone invoice is only for a variation covered by an approved PO amendment, and never lifts the milestone above its amount */
function debitNoteErrors(inv, amount, variationRef) {
  const po = getPO(inv.poId); if (!po || po.billingMethod !== 'Milestone') return '';
  const am = (po.amendments || []).find(x => String(x.version) === String(variationRef) || x.id === variationRef);
  if (!variationRef || !am) return `A debit note (or extra invoice) for a variation needs an approved PO amendment — enter the amendment version (${(po.amendments || []).length ? 'e.g. v' + po.amendments[0].version : 'this PO has none yet'}).`;
  if (am.at && inv.submittedAt && am.at < inv.submittedAt) return `Amendment v${am.version} (${fmtD(am.at)}) is older than ${invRef(inv)} — a variation must be approved before it is billed.`;
  const room = r2(sum(inv.allocs.filter(a => a.kind === 'milestone'), a => { const m = getMS(a.refId); return m ? Math.max(0, m.amount - usage('milestone', m.id).value) : 0; }));
  const debits = r2(sum(adjOf(inv).filter(x => x.type === 'Debit'), x => x.amount)), base = r2(amount / (1 + gstOf(po) / 100));
  if (base + debits > room + EPS) return `The debit would take the milestone above its amount — only ${money(room)} of milestone value remains. Raise the milestone by amendment first.`;
  return '';
}
/* ---------- validation gate shared by form, submit and matching ---------- */
function allocErrors(inv) {
  const po = getPO(inv.poId), errs = [], ex = inv.id;
  const add = (code, msg, ref) => errs.push({ code, msg, ref });
  if (!po) return [{ code: 'PO', msg: 'Select an approved purchase order.' }];
  const net = inv.net, poVal = poNet(po);
  if (!(net > 0)) add('NET', po.billingMethod === 'Standard' ? 'Enter an invoice amount greater than zero.' : 'Allocate a quantity/value greater than zero against at least one source.');
  const otherLive = poConsumed(po, ex), own = inv.advanceId ? net : r2(net - ((inv.recovery && inv.recovery.net) || 0));
  if (net > 0 && r2(otherLive + own) > poVal + EPS) add('PO_BAL', `Cumulative invoicing would reach ${money(otherLive + own)}, exceeding the PO value ${money(poVal)}. Remaining PO balance: ${money(poVal - otherLive)}.`);
  const items = sourceItems(po, ex);
  if (po.billingMethod === 'Standard') {
    const accepted = sum(items, x => x.entValue);
    if (accepted <= EPS) add('NOT_ELIGIBLE', `No accepted ${recLabel(po)} receipts exist against this PO. Receive and accept first — pending or rejected quantities are not invoice-eligible.`);
    else if (net > 0 && net > accepted - otherLive + EPS) add('OVER_VALUE', `Invoice amount ${money(net)} exceeds the accepted receipt value still unbilled. Accepted receipts: ${money(accepted)}; already invoiced / reserved: ${money(otherLive)}; eligible: ${money(accepted - otherLive)}.`);
    return errs;
  }
  if (inv.allocs.some(a => a.kind === 'advance') && inv.allocs.some(a => a.kind !== 'advance')) add('ADV_MIX', 'An advance invoice can carry only its advance — raise milestone invoices separately.');
  const kindName = po.billingMethod === 'Milestone' ? 'milestone' : (poCertified(po) ? 'progress claim' : recLabel(po));
  if (!inv.allocs.length) add('NO_ALLOC', `Select at least one ${kindName} to invoice against.`);
  const seen = new Set();
  inv.allocs.forEach(a => {
    const key = a.kind + a.refId;
    const it = items.find(x => x.kind === a.kind && x.refId === a.refId);
    if (!it) { add('NO_SOURCE', 'An allocation references a record that does not belong to this PO.'); return; }
    if (seen.has(key)) { add('DUP_ALLOC', `Duplicate allocation: ${it.label} appears more than once on this invoice.`, it.label); return; }
    seen.add(key);
    const isQty = a.kind === 'grn';
    if (isQty ? !(a.qty > 0) : !(a.value > 0)) { add('NET', `Enter ${isQty ? 'a quantity' : 'an amount'} for ${it.label}.`, it.label); return; }
    const byInv = it.invs.length ? it.invs.map(i => `${invRef(i)} (${i.status})`).join(', ') : '';
    if (a.kind === 'milestone') {
      const m = it.ref, gate = msGate(m, po);
      if (m.status === 'Approved') { const dep = unmetDeps(m, po, 'bill'); if (dep.length) return add('DEP', `Milestone ${m.code} depends on ${dep.map(d => d.code).join(', ')}: ${dep.map(d => d.why).join('; ')}. Dependency gate.`, it.label); }
      if (m.status !== 'Approved') return add('MS_NOT_APPROVED', `Milestone ${m.code} is not invoice-eligible: status is "${m.status}". Only an approved milestone can be invoiced; a passed due date does not make it eligible.`, it.label);
      if (!gate.ok) return add('GATE', `Milestone ${m.code} is approved but cannot be invoiced yet: ${gate.reason}. Approval does not replace the other acceptance conditions.`, it.label);
      if (a.lines && a.lines.length) { const le = lineLevelErrors(po, m, a, inv); if (le.length) { le.forEach(e => add(e.code, e.msg, it.label)); return; } }
      if (!m.allowPartial) {
        if (it.usedValue <= EPS && it.entValue < m.amount - EPS) return add('GATE', `Milestone ${m.code} is approved but only ${money(it.entValue)} of ${money(m.amount)} is accepted so far, so it cannot be invoiced yet. Partial invoicing is not enabled on it — it is billed once, in full, after the remaining quantity is accepted.`, it.label);
        if (it.usedValue > EPS) return add('DUP_ALLOC', `Duplicate allocation blocked: milestone ${m.code} (${money(m.amount)}) is already invoiced on ${byInv}. Only one invoice is allowed per milestone.`, it.label);
        if (Math.abs(a.value - m.amount) > EPS) return add('MS_FULL', `Milestone ${m.code} must be invoiced for its full amount (${money(m.amount)}); partial invoicing is not enabled on it. Requested: ${money(a.value)}.`, it.label);
      } else {
        if (it.availValue <= EPS) return add('DUP_ALLOC', `Duplicate allocation blocked: milestone ${m.code} (${money(m.amount)}) is fully invoiced on ${byInv}.`, it.label);
        if (a.lines && a.lines.length) { const sr = sliceRemaining(m, po, inv.id); for (const x of a.lines) { const sl = sr.find(y => y.line.id === x.lineId); if (!sl) return add('NO_SOURCE', `Line ${x.lineId} is not in the scope of milestone ${m.code}.`, it.label); if (x.value > sl.remaining + EPS) return add('OVER_VALUE', `${sl.line.desc} on ${m.code}: only ${money(sl.remaining)} remains eligible; the invoice line is ${money(x.value)}.`, it.label); } }
        if (a.value > it.availValue + EPS) return add('OVER_VALUE', `Invoice value exceeds the remaining balance of milestone ${m.code}. Approved ${money(it.entValue)}, already invoiced / reserved ${money(it.usedValue)}, remaining ${money(it.availValue)}. Requested: ${money(a.value)}.`, it.label);
      }
    } else if (a.kind === 'claim') {
      const c = it.ref;
      if (c.status !== 'Certified') return add('NOT_ELIGIBLE', `${c.number} is not invoice-eligible: claim status is "${c.status}". Only certified progress can be invoiced.`, it.label);
      if (it.availValue <= EPS) return add('DUP_ALLOC', `Duplicate allocation blocked: certified value of ${c.number} (${money(it.entValue)}) is already allocated to ${byInv}.`, it.label);
      if (a.value > it.availValue + EPS) return add('OVER_VALUE', `Invoice value exceeds the certified value remaining against ${c.number}. Eligible: ${money(it.availValue)}. Requested: ${money(a.value)}.`, it.label);
    } else if (a.kind === 'grn') {
      if (it.entQty <= 0) return add('NOT_ELIGIBLE', `${it.label} is not invoice-eligible: ${it.reason}.`, it.label);
      if (it.availQty <= EPS) return add('DUP_ALLOC', `Duplicate allocation blocked: all ${fmtNum(it.entQty)} accepted units of ${it.label} are already allocated to ${byInv}.`, it.label);
      if (a.qty > it.availQty + EPS) return add('OVER_QTY', `Invoice quantity exceeds the eligible quantity remaining against ${it.label}. Eligible: ${fmtNum(it.availQty)} units. Requested: ${fmtNum(a.qty)} units.`, it.label);
    } else if (a.kind === 'advance') {
      advAllocError(a, it, add, inv, po);
    } else if (a.kind === 'srn') {
      if (it.entValue <= 0) return add('NOT_ELIGIBLE', `${it.label} is not invoice-eligible: ${it.reason}.`, it.label);
      if (it.availValue <= EPS) return add('DUP_ALLOC', `Duplicate allocation blocked: the accepted value of ${it.label} (${money(it.entValue)}) is already allocated to ${byInv}.`, it.label);
      if (a.value > it.availValue + EPS) return add('OVER_VALUE', `Invoice value exceeds the eligible value remaining against ${it.label}. Eligible: ${money(it.availValue)}. Requested: ${money(a.value)}.`, it.label);
    }
  });
  return errs;
}

/* an approved / posted / paid invoice whose source entitlement later dropped (receipt reversed or reduced) is never altered — it is flagged for AP review with the overage */
function apReview(inv) {
  if (!inv || inv.reversed || !APPROVED.includes(inv.status)) return null;
  const po = getPO(inv.poId); if (!po) return null;
  if (po.billingMethod === 'Standard') {
    const accepted = sum(sourceItems(po), x => x.entValue), live = sum(invsOf(po).filter(isLive), i => i.net), over = r2(live - accepted);
    return over > EPS ? { amount: over, refs: ['PO level'] } : null;
  }
  const items = sourceItems(po); let over = 0; const refs = [];
  inv.allocs.forEach(a => { const it = items.find(x => x.kind === a.kind && x.refId === a.refId); if (!it || it.kind === 'advance') return; const extra = it.kind === 'milestone' ? sum(advOfMs(it.ref), x => advO(x)) : 0, o = r2(it.usedValue + extra - it.entValue); if (o > EPS) { over = r2(over + Math.min(o, a.value + extra)); refs.push(it.label); } });
  return over > EPS ? { amount: over, refs } : null;
}
/* E06: when a receipt is reversed, every unposted invoice that relied on it is re-matched at once; the ones that no longer match fall to Matching Failed and release their hold */
function revalidateDependents(po, kind, refId, why) {
  const hit = [];
  db.invoices.filter(i => i.poId === po.id && !i.reversed && ['Submitted', 'Pending Matching', 'Pending Approval', 'Approved'].includes(i.status)
    && (po.billingMethod === 'Standard' || i.allocs.some(a => (a.kind === kind && a.refId === refId) || (a.kind === 'milestone' && (((getMS(a.refId) || {}).grnIds || []).includes(refId) || ((getMS(a.refId) || {}).srnIds || []).includes(refId)))))
  ).forEach(i => {
    const ev = evaluateInvoice(i);
    if (ev.result !== 'Blocked') return;
    i.match = { at: nowISO(), by: actor(), result: ev.result, checks: ev.checks };
    setStatus(i, 'Matching Failed', why);
    audit(po.id, invRef(i), `${invRef(i)} failed re-matching after ${why} — allocation released; the supplier is notified to correct and resubmit.`, 'bad'); hit.push(i);
  });
  return hit;
}

/* ---------- matching engine ---------- */
function evaluateInvoice(inv) {
  const po = getPO(inv.poId), sup = po && getSup(po.supplierId), errs = po ? allocErrors(inv) : [];
  const checks = [];
  const C = (key, label, status, detail) => checks.push({ key, label, status, detail });
  const by = (...codes) => errs.filter(e => codes.includes(e.code));
  if (!po) { C('po', 'PO match', 'fail', 'Purchase order not found.'); return { checks, result: 'Blocked' }; }
  C('po', 'PO match', po.status === 'Approved' ? 'pass' : 'fail', po.status === 'Approved' ? `${po.number} is Approved (v${po.version}) · billing method inherited: ${methodLabel(po)}.` : `${po.number} is ${po.status}; only approved POs can be invoiced.`);
  C('supplier', 'Vendor match', inv.supplierId === po.supplierId ? 'pass' : 'fail', inv.supplierId === po.supplierId ? `${sup.name} (${sup.code}) matches the PO vendor.` : 'Invoice vendor differs from the PO vendor.');
  const e1 = by('NOT_ELIGIBLE', 'MS_NOT_APPROVED', 'GATE', 'NO_SOURCE', 'NO_ALLOC', 'DUP_ALLOC', 'DEP', 'ADV_MIX');
  const refs = inv.allocs.map(a => { const it = sourceItems(po, inv.id).find(x => x.kind === a.kind && x.refId === a.refId); return it ? it.label : '?'; });
  const eligLabel = po.billingMethod === 'Milestone' ? 'Milestone eligibility' : poCertified(po) ? 'Certified progress eligibility' : `Receipt eligibility (${recLabel(po)})`;
  if (e1.length) C('elig', eligLabel, 'fail', e1.map(e => e.msg).join(' '));
  else if (po.billingMethod === 'Standard') C('elig', eligLabel, 'pass', `Accepted receipts of ${money(sum(sourceItems(po, inv.id), x => x.entValue))} are available on the PO (standard receipt-based matching, no allocation schedule).`);
  else if (po.billingMethod === 'Milestone') C('elig', eligLabel, 'pass', `${refs.join(', ')} approved — ${inv.allocs.some(a => a.kind === 'milestone' && msGate(getMS(a.refId), po).required) ? 'every configured acceptance condition (document approval / accepted GRN / accepted SRN) is satisfied' : 'no extra acceptance condition configured'}.`);
  else C('elig', eligLabel, 'pass', `${refs.join(', ')} accepted and unconsumed — pending and rejected quantities excluded.`);
  const eL = by('RATE', 'UOM', 'TAX', 'LINE');
  if (eL.length) C('lines', 'Invoice line match (rate · unit · tax)', 'fail', eL.map(e => e.msg).join(' '));
  else if (inv.allocs.some(a => a.lines && a.lines.length)) C('lines', 'Invoice line match (rate · unit · tax)', 'pass', `Every invoice line names a PO line and a milestone portion; rates, units and tax rates agree with the PO lines${inv.taxMixed ? ' (mixed tax rates — the header GST is the sum of the lines)' : ''}.`);
  const e2 = by('OVER_QTY', 'OVER_VALUE', 'MS_FULL', 'NET');
  if (e2.length) C('qty', 'Quantity / value match', 'fail', e2.map(e => e.msg).join(' '));
  else if (po.billingMethod === 'Standard') C('qty', 'Quantity / value match', 'pass', `Invoice amount ${money(inv.net)} ≤ accepted unbilled receipt value.`);
  else C('qty', 'Quantity / value match', 'pass', `Allocations total ${money(sum(inv.allocs, a => a.value))} = invoice amount ${money(inv.net)}; every allocation is within its remaining eligible ${po.billingMethod === 'Milestone' ? 'milestone balance' : 'quantity/value'}.`);
  const dups = db.invoices.filter(i => i.id !== inv.id && i.supplierId === inv.supplierId && !['Draft', 'Cancelled', 'Rejected'].includes(i.status) && String(i.number).trim().toLowerCase() === String(inv.number).trim().toLowerCase());
  C('dup', 'Duplicate invoice check', dups.length ? 'fail' : 'pass', dups.length ? `Bill number "${inv.number}" was already submitted by ${sup.name} as ${dups.map(d => `${invRef(d)} (${d.status})`).join(', ')}.` : `Bill number "${inv.number}" is unique for ${sup.name}.`);
  const otherLive = poConsumed(po, inv.id), poVal = poNet(po), ownNet = inv.advanceId ? inv.net : r2(inv.net - ((inv.recovery && inv.recovery.net) || 0));
  const eb = by('PO_BAL');
  C('bal', 'PO remaining balance', eb.length ? 'fail' : 'pass', eb.length ? eb[0].msg : `PO ${money(poVal)} − other consumption (invoiced + unrecovered advance) ${money(otherLive)} − this invoice ${money(ownNet)} = ${money(poVal - otherLive - ownNet)} remaining.`);
  if (inv.damages && inv.damages.items.length) C('dmg', 'Delay damages', 'pass', inv.damages.items.map(x => `${x.code} finished ${x.lateDays} day(s) late = ${x.weeks} week(s) or part × ${x.ratePct}%${x.capped ? ' (capped at ' + x.capPct + '%)' : ''} = ${money(x.amount)}`).join('; ') + `; deducted from the payable (${money(payable(inv))}).`);
  if (inv.recovery && inv.recovery.items.length) C('adv', 'Advance recovery', 'pass', `Recovering ${money(inv.recovery.net)} of advance on this invoice${inv.recovery.gst ? ` (GST ${money(inv.recovery.gst)} reversed)` : ''}; cash payable ${money(payable(inv))}.`);
  const exp = (inv.advanceId && poCfg(po).advanceGstMode === 'taxed_at_final') ? 0 : inv.taxMixed ? inv.gstCalc : r2((inv.net - (inv.discount || 0)) * inv.gstRate / 100), diff = Math.abs(exp - inv.gst);
  if (inv.gstRate !== gstOf(po)) C('gst', 'GST validation', 'fail', `GST rate ${inv.gstRate}% differs from the ${gstOf(po)}% on the PO.`);
  else if (diff <= 0.01) C('gst', 'GST validation', 'pass', `GST ${money(inv.gst)} = ${inv.gstRate}% of ${money(inv.net - (inv.discount || 0))}; total ${money(inv.gross)}.`);
  else if (diff <= 1) C('gst', 'GST validation', 'warn', `GST ${money(inv.gst)} differs from the computed ${money(exp)} by ${money(diff)} (within the ${money(1)} rounding tolerance).`);
  else C('gst', 'GST validation', 'fail', `GST ${money(inv.gst)} does not equal ${inv.gstRate}% of ${money(inv.net - (inv.discount || 0))} (expected ${money(exp)}, variance ${money(diff)}).`);
  const result = checks.some(c => c.status === 'fail') ? 'Blocked' : checks.some(c => c.status === 'warn') ? 'Partially Matched' : 'Matched';
  C('appr', 'Approval routing', result === 'Blocked' ? 'info' : 'pass', result === 'Blocked' ? 'Not routed — resolve the exceptions above, then re-run matching.' : 'Eligible to route to the AP Manager approval queue.');
  return { checks, result, errors: errs };
}

/* =====================================================================
   Actions (state transitions). All return { ok, msg?, errors?, id? }
   ===================================================================== */
const A = {};
const OK = (msg, extra = {}) => ({ ok: true, msg, ...extra });
const NO = (errors, msg) => ({ ok: false, errors: [].concat(errors), msg: msg || [].concat(errors)[0] });

/* ----- Purchase orders ----- */
function validatePO(d, forSubmit) {
  const errs = [], v = d.lines.reduce((s, l) => s + (+l.qty || 0) * (+l.price || 0), 0);
  if (!['Goods', 'Services', 'Mixed'].includes(d.type)) errs.push('Select the PO type (Goods, Services or Mixed).');
  if (!d.supplierId) errs.push('Select a vendor.');
  if (!String(d.title || '').trim()) errs.push('Enter an order title.');
  if (!d.office) errs.push('Select the billing office.');
  if (!d.poDate) errs.push('PO date is required.');
  if (!d.deliveryDate) errs.push('Delivery date is required.');
  if (d.deliveryDate && d.poDate && d.deliveryDate < d.poDate) errs.push('Delivery date cannot be before the PO date.');
  if (d.endDate && d.deliveryDate && d.endDate < d.deliveryDate) errs.push('End date cannot be before the delivery date.');
  if (!GST_RATES.includes(+d.gstRate)) errs.push('Select a valid GST rate.');
  if (!d.lines.length) errs.push('Add at least one line item.');
  d.lines.forEach((l, i) => {
    if (!String(l.desc || '').trim()) errs.push(`Line ${i + 1}: description is required.`);
    if (!(+l.qty > 0)) errs.push(`Line ${i + 1}: quantity must be greater than zero.`);
    if (l.price === '' || !(+l.price >= 0)) errs.push(`Line ${i + 1}: unit price is required.`);
  });
  if (!d.billingMethod) errs.push('Select a billing method.');
  if (d.billingMethod === 'Progressive' && d.progressBasis === 'Certified' && d.type !== 'Services') errs.push('Certified work progress is only available on Services POs. Use accepted receipts (GRN / SRN) otherwise.');
  const anyGoods = d.type === 'Goods' || (d.type === 'Mixed' && d.lines.some(l => l.kind !== 'Services')), anySvc = d.type === 'Services' || (d.type === 'Mixed' && d.lines.some(l => l.kind === 'Services'));
  if (d.type === 'Mixed' && !(anyGoods && anySvc)) errs.push('A Mixed PO needs at least one goods line and one services line.');
  if (d.billingMethod === 'Milestone') (d.milestones || []).forEach((m, i) => {
    if (m.needsGrn && !anyGoods) errs.push(`M${i + 1}: a GRN requirement needs at least one goods line on the PO.`);
    if (m.needsSrn && !anySvc) errs.push(`M${i + 1}: an SRN requirement needs at least one services line on the PO.`);
    if (m.needsDoc && !String(m.docTitle || '').trim()) errs.push(`M${i + 1}: name the document that must be approved (e.g. Commissioning Certificate).`);
  });
  if (d.billingMethod === 'Milestone') (d.milestones || []).forEach((m, i) => {
    if (m.needsGuarantee && !String(m.guaranteeTitle || '').trim()) errs.push(`M${i + 1}: name the guarantee that Finance must verify (e.g. Performance bank guarantee).`);
    depCodes(m).forEach(c => { if (c === `M${i + 1}`) errs.push(`M${i + 1}: a milestone cannot depend on itself.`); else if (!(d.milestones || []).some((x, k) => `M${k + 1}` === c)) errs.push(`M${i + 1}: depends on ${c}, which does not exist.`); });
    if (m.durationDays != null && m.durationDays !== '' && !(+m.durationDays >= 0)) errs.push(`M${i + 1}: duration must be zero or more days.`);
    trigErrors(d.lines, m, `M${i + 1}`).forEach(e => errs.push(e));
    if (m.requireCompleteQty && !(explicitScope(m) && m.scope.some(x => x.basis === 'quantity'))) errs.push(`M${i + 1}: "complete quantity" needs at least one scope row on a quantity basis.`);
  });
  if (d.billingMethod === 'Milestone') { const cyc = depCycle((d.milestones || []).map((m, i) => ({ ...m, code: `M${i + 1}` }))); if (cyc) errs.push(`Dependency cycle: ${cyc.join(' → ')}. A milestone cannot (indirectly) wait for itself.`); }
  if (forSubmit) {
    if (!(v > 0)) errs.push('PO value must be greater than zero.');
    if (d.billingMethod === 'Milestone') {
      ensureLineIds(d.lines);
      const hasScope = d.milestones.some(explicitScope), anyOut = d.lines.some(isOutside);
      if (!d.lines.some(l => !isOutside(l))) errs.push('Milestone schedule: every line is billed outside the schedule — nothing is left to schedule.');
      else if (!hasScope) scheduleCheck(d.milestones, anyOut ? scheduleBase(d.lines) : r2(v)).errors.forEach(e => errs.push('Milestone schedule: ' + e));
      else buildSchedule(d.lines, d.milestones).errors.forEach(e => errs.push('Milestone schedule: ' + e));
      if (!errs.length) advanceTermErrors(d, buildSchedule(d.lines, d.milestones).amounts).forEach(e => errs.push(e));
    }
  }
  return errs;
}
A.savePO = (d, submit) => {
  if (d.billingMethod === 'Milestone') ensureLineIds(d.lines);
  const errs = validatePO(d, submit);
  if (errs.length) return NO(errs, 'Please fix the highlighted issues.');
  let po = d.id && getPO(d.id), isNew = !po;
  if (po && po.status !== 'Draft') return NO(`${po.number} is ${po.status} — only draft POs can be edited. Use Amend PO for an approved PO.`);
  if (isNew) {
    const seqNo = Math.max(41, ...db.pos.map(p => p.seqNo || 0)) + 1;
    po = { id: uid('po'), seqNo, number: poNumberFor(d.poDate, seqNo), version: 1, amendments: [], approvals: [], createdBy: actor(), createdAt: nowISO() };
    db.pos.push(po);
  }
  Object.assign(po, {
    supplierId: d.supplierId, buyer: d.buyer || 'DICE Manufacturing Pvt Ltd', office: d.office, title: d.title.trim(), poDate: d.poDate, deliveryDate: d.deliveryDate, endDate: d.endDate || '',
    type: d.type, category: d.category, attachments: d.attachments || [], currency: CURRENCY, gstRate: +d.gstRate, billingMethod: d.billingMethod, progressBasis: d.billingMethod === 'Progressive' ? d.progressBasis : 'Receipt',
    overReceiptPct: po.overReceiptPct || 0, status: submit ? 'Pending Approval' : 'Draft',
    lines: d.lines.map((l, i) => ({ id: l.id || uid('ln'), no: i + 1, desc: l.desc.trim(), qty: +l.qty, uom: l.uom, price: +l.price, kind: d.type === 'Mixed' ? (l.kind === 'Services' ? 'Services' : 'Goods') : d.type, outside: d.billingMethod === 'Milestone' && !!l.outside, gstRate: l.gstRate !== '' && l.gstRate != null && GST_RATES.includes(+l.gstRate) ? +l.gstRate : null, convs: normConvs(l.convsText != null ? l.convsText : l.convs) })),
    settings: { ...PO_DEFAULTS, ...(d.settings || {}) }, scheduleOpen: null,
  });
  db.milestones = db.milestones.filter(m => m.poId !== po.id);          // schedule is only editable while the PO is a draft
  if (po.billingMethod === 'Milestone') {
    const sch = buildSchedule(po.lines, d.milestones);
    d.milestones.forEach((m, i) => db.milestones.push(makeMilestone(po, m, i, sch)));
  }
  audit(po.id, po.number, isNew ? `PO created${submit ? ' and submitted for approval' : ' as draft'} — billing method ${po.billingMethod}.` : `PO ${submit ? 'submitted for approval' : 'saved as draft'} (billing method ${po.billingMethod}).`, 'po');
  if (submit) po.approvals.push({ at: nowISO(), by: actor(), action: 'Submitted for approval', note: '' });
  save();
  return OK(submit ? `${po.number} submitted for approval` : `${po.number} saved as draft`, { id: po.id });
};
A.approvePO = id => {
  const po = getPO(id); if (!po || po.status !== 'Pending Approval') return NO('PO is not awaiting approval.');
  po.status = 'Approved';
  msOf(po).forEach(m => { if (m.status === 'Draft') { m.status = 'Pending'; (m.history = m.history || []).push({ at: nowISO(), by: actor(), role: db.meta.role, from: 'Draft', to: 'Pending', note: 'PO approved — milestone schedule approved with it' }); } });
  po.approvals.push({ at: nowISO(), by: actor(), action: 'Approved', note: '' });
  audit(po.id, po.number, `PO approved. Now available for ${recLabel(po)}${po.billingMethod === 'Milestone' ? ' / milestone work' : ''} and invoice selection.`, 'po');
  save(); return OK(`${po.number} approved`);
};
A.rejectPO = (id, reason) => {
  const po = getPO(id); if (!po || po.status !== 'Pending Approval') return NO('PO is not awaiting approval.');
  if (!String(reason || '').trim()) return NO('A rejection reason is required.');
  po.status = 'Rejected'; po.approvals.push({ at: nowISO(), by: actor(), action: 'Rejected', note: reason });
  audit(po.id, po.number, `PO rejected: ${reason}`, 'bad'); save(); return OK(`${po.number} rejected`);
};
A.reopenPO = id => { const po = getPO(id); if (!po || !['Rejected', 'Pending Approval'].includes(po.status)) return NO('Cannot revise this PO.'); po.status = 'Draft'; audit(po.id, po.number, 'PO returned to draft for revision.', 'po'); save(); return OK('PO returned to draft'); };
const advConsumedOn = m => r2(usage('milestone', m.id).value + sum(advOfMs(m), a => advO(a)));
function amendRemovals(po, milestones, errs) {
  const removed = msOf(po).filter(m => milestones.some(x => x.id === m.id && x.remove));
  removed.forEach(m => { const u = usage('milestone', m.id), open = advOfMs(m).filter(a => advO(a) > EPS);
    if (u.value > EPS) errs.push(`${m.code} cannot be cancelled: it has ${money(u.value)} allocated on ${u.invs.map(invRef).join(', ')}. Reverse or cancel those invoices first — invoiced history is never rewritten.`);
    else if (open.length) errs.push(`${m.code} cannot be cancelled: advance ${open.map(a => a.number).join(', ')} of ${money(sum(open, a => advO(a)))} is outstanding. Refund the advance first.`);
    else if (msLocked(m)) errs.push(`${m.code} cannot be cancelled: it is already ${m.status.toLowerCase()}. Only a milestone that has not been submitted can be cancelled by amendment.`);
    else if ((m.grnIds || []).length || (m.srnIds || []).length) errs.push(`${m.code} cannot be cancelled: receipts are linked to it. Unlink them first.`); });
  return removed;
}
function finishAmend(po, before, changes, reason) {
  po.version += 1;
  po.scheduleOpen = po.billingMethod === 'Milestone' && scheduleGaps(po).length ? scheduleGaps(po) : null;
  po.amendments.unshift({ id: uid('am'), version: po.version, at: nowISO(), by: actor(), reason, changes, valueBefore: before, valueAfter: poNet(po) });
  audit(po.id, po.number, `PO amended to v${po.version} (${money(before)} → ${money(poNet(po))}). ${changes.join('; ') || 'No value change.'} Historical invoice allocations preserved. Reason: ${reason}${po.scheduleOpen ? ' — schedule reopened: ' + po.scheduleOpen.join(' ') : ''}`, 'po');
  save(); return OK(`${po.number} amended to v${po.version}`);
}
/* rescale a simple "% of PO" milestone after its percentage / the lines changed: percent slices of every scheduled line, last slice absorbs the rounding against the milestone amount */
function rescopeSimple(po, m) {
  m.scope = simpleScope(po.lines, m.pct).map(x => ({ ...x, value: sliceRaw(x, lineOf(po, x.lineId)) }));
  if (m.scope.length) { const d = r2(m.amount - sum(m.scope, x => x.value)); m.scope[m.scope.length - 1].value = r2(m.scope[m.scope.length - 1].value + d); }
}
A.amendPO = (id, { lines, milestones, reason, settings }) => {
  const po = getPO(id); if (!po || po.status !== 'Approved') return NO('Only approved POs can be amended.');
  milestones = milestones || [];
  const errs = [];
  if (!String(reason || '').trim()) errs.push('An amendment reason is required.');
  const before = poNet(po), changes = [];
  const next = po.lines.map(l => { const n = lines.find(x => x.id === l.id) || l; return { ...l, qty: +n.qty, price: +n.price }; });
  next.forEach(n => {
    const o = lineOf(po, n.id), touched = grnsOf(po).some(g => g.lineId === o.id) || srnsOf(po).some(s => s.lineId === o.id) || invsOf(po).some(i => isLive(i));
    if (!(n.qty > 0) || !(n.price >= 0)) errs.push(`Line ${o.no}: enter a valid quantity and price.`);
    if (n.price !== o.price && touched) errs.push(`Line ${o.no}: unit price is locked because receipts or invoices already exist — historical amounts are never rewritten.`);
    if (lineKind(po, o) === 'Goods' && n.qty < lineReceiptStats(po, { ...o, qty: 0 }).active - EPS) errs.push(`Line ${o.no}: quantity cannot drop below the quantity already received/accepted (${fmtNum(lineReceiptStats(po, { ...o, qty: 0 }).active)}).`);
    if (lineKind(po, o) === 'Services' && n.qty * n.price < lineServiceStats(po, { ...o, qty: 1, price: 0 }).active - EPS) errs.push(`Line ${o.no}: value cannot drop below the service value already received (${money(lineServiceStats(po, o).active)}).`);
    if (n.qty !== o.qty) changes.push(`Line ${o.no} quantity ${fmtNum(o.qty)} → ${fmtNum(n.qty)}`);
    if (n.price !== o.price) changes.push(`Line ${o.no} price ${fmtNum(o.price)} → ${fmtNum(n.price)}`);
  });
  const after = sum(next, l => l.qty * l.price), consumed = poConsumed(po);
  if (after < consumed - EPS) errs.push(`Amended PO value ${money(after)} cannot be lower than invoices already submitted (${money(consumed)}, including unrecovered advances).`);
  const scoped = po.billingMethod === 'Milestone' && (msOf(po).some(m => !m.simple) || po.lines.some(isOutside));
  let plan = null;
  if (po.billingMethod === 'Milestone') {
    const locked = msLocked, removed = amendRemovals(po, milestones, errs), cur = msOf(po).filter(m => !removed.includes(m));
    if (scoped) {
      const nl = next;
      cur.forEach(m => { if (locked(m)) return; const amt = sum(m.scope || [], x => { const ln = nl.find(l => l.id === x.lineId); return ln ? sliceRaw(x, ln) : x.value; });
        const c = advConsumedOn(m); if (amt < c - EPS) errs.push(`${m.code} cannot be amended below ${money(c)}: invoiced ${money(usage('milestone', m.id).value)} plus unrecovered advance ${money(sum(advOfMs(m), a => advO(a)))}.`); });
      if (!errs.length) plan = { scoped: true, cur, removed, nl };
    } else {
      const merged = cur.map(m => { const n = milestones.find(x => x.id === m.id); if (!n || locked(m)) return { ...m }; return { ...m, name: n.name, pct: +n.pct }; });
      const added = milestones.filter(x => !x.id || String(x.id).startsWith('new')).filter(x => String(x.name || '').trim() && +x.pct > 0).map(x => ({ name: x.name, pct: +x.pct, planned: x.planned || '', needsDoc: !!x.needsDoc, docTitle: x.docTitle || '', needsGrn: !!x.needsGrn, needsSrn: !!x.needsSrn, allowPartial: !!x.allowPartial }));
      added.forEach(x => { if (x.needsGrn && !hasGoods(po)) errs.push(`New milestone "${x.name}": the PO has no goods lines, so it cannot require a GRN.`); if (x.needsSrn && !hasServices(po)) errs.push(`New milestone "${x.name}": the PO has no services lines, so it cannot require an SRN.`); });
      const all = [...merged, ...added];
      const chk = scheduleCheck(all.map(m => m.id && locked(m) ? { ...m, pct: m.amount / after * 100 } : m), after);
      chk.errors.forEach(e => errs.push('Amended schedule: ' + e));
      if (!errs.length) {
        let used = sum(all.filter(m => m.id && locked(m)), m => m.amount); const free = all.filter(m => !(m.id && locked(m)));
        free.forEach((m, i) => { const amt = i === free.length - 1 ? r2(after - used) : r2(m.pct * after / 100); used = r2(used + amt); if (m.id) { const c = advConsumedOn(getMS(m.id)); if (amt < c - EPS) errs.push(`${m.code} cannot be amended below ${money(c)}: invoiced ${money(usage('milestone', m.id).value)} plus unrecovered advance ${money(sum(advOfMs(getMS(m.id)), a => advO(a)))}.`); } });
      }
      if (!errs.length) plan = { cur, merged, added, locked, removed };
    }
  }
  if (errs.length) return NO(errs, 'Amendment rejected — see issues.');
  next.forEach(n => { const l = lineOf(po, n.id); l.qty = n.qty; l.price = n.price; });
  if (settings) { const st = poCfg(po); ['overReceiptPct'].forEach(k => { if (settings[k] != null && +settings[k] !== (po[k] || 0)) { changes.push(`${k} ${po[k] || 0} → ${+settings[k]}`); po[k] = Math.max(0, +settings[k]); } });
    ['maxAdvancePctPerMilestone', 'maxAdvancePctOfPO', 'valueTolerancePct'].forEach(k => { if (settings[k] != null && +settings[k] !== st[k]) { changes.push(`${k} ${st[k]} → ${+settings[k]}`); po.settings = { ...st, ...po.settings, [k]: Math.max(0, +settings[k]) }; } });
    if (settings.advanceGstMode && settings.advanceGstMode !== st.advanceGstMode && !advsOf(po).some(a => advInvoiceOf(a))) { changes.push(`advanceGstMode ${st.advanceGstMode} → ${settings.advanceGstMode}`); po.settings = { ...st, ...po.settings, advanceGstMode: settings.advanceGstMode }; }
    if (settings.enforceDependencies != null && !!settings.enforceDependencies !== !!st.enforceDependencies) { changes.push(`enforceDependencies ${!!st.enforceDependencies} → ${!!settings.enforceDependencies}`); po.settings = { ...st, ...po.settings, enforceDependencies: !!settings.enforceDependencies }; }
    if (settings.dueBasis && settings.dueBasis !== st.dueBasis) { changes.push(`invoice due basis ${st.dueBasis} → ${settings.dueBasis}`); po.settings = { ...st, ...po.settings, dueBasis: settings.dueBasis }; }
    if (settings.dueDays != null && String(settings.dueDays) !== String(st.dueDays ?? '')) { changes.push(`invoice due days ${st.dueDays || 'default'} → ${settings.dueDays || 'default'}`); po.settings = { ...st, ...po.settings, dueDays: settings.dueDays === '' ? '' : Math.max(0, +settings.dueDays) }; } }
  if (plan && plan.scoped) {
    plan.removed.forEach(m => { changes.push(`Cancelled milestone ${m.code} "${m.name}" (${money(m.amount)})`); msOf(po).filter(x => depCodes(x).includes(m.code) && !plan.removed.includes(x)).forEach(x => changes.push(`${x.code} depended on ${m.code} — blocked until re-pointed`)); advOfMs(m).forEach(a => { if (!a.rejected && !advInvoiceOf(a)) { a.rejected = true; a.rejectReason = `Milestone ${m.code} cancelled by PO amendment`; } }); db.milestones = db.milestones.filter(x => x.id !== m.id); });
    plan.cur.forEach(m => { if (msLocked(m)) return; (m.scope || []).forEach(x => { const ln = lineOf(po, x.lineId); if (ln) x.value = sliceRaw(x, ln); }); const amt = sum(m.scope || [], x => x.value); if (amt !== m.amount) { changes.push(`${m.code} "${m.name}" amount ${money(m.amount)} → ${money(amt)}`); m.amount = amt; } const n = milestones.find(x => x.id === m.id); if (n && n.name && n.name !== m.name) m.name = n.name; });
    msOf(po).forEach(m => { const base = scheduleBase(po.lines); m.pct = base ? Math.round(m.amount / base * 1e8) / 1e6 : 0; });
  } else if (plan) {
    const { cur, merged, added, locked, removed } = plan;
    removed.forEach(m => { changes.push(`Cancelled milestone ${m.code} "${m.name}" (${money(m.amount)})`); advOfMs(m).forEach(a => { if (!a.rejected && !advInvoiceOf(a)) { a.rejected = true; a.rejectReason = `Milestone ${m.code} cancelled by PO amendment`; } }); db.milestones = db.milestones.filter(x => x.id !== m.id); });
    const rows = [...merged, ...added];                                         // existing first, then new
    let used = sum(rows.filter(m => m.id && locked(m)), m => m.amount);
    const free = rows.filter(m => !(m.id && locked(m)));
    free.forEach((m, i) => { m.amount = i === free.length - 1 ? r2(after - used) : r2(m.pct * after / 100); used = r2(used + m.amount); });
    cur.forEach(m => { const n = merged.find(x => x.id === m.id); if (!locked(m)) { if (m.name !== n.name || m.amount !== n.amount) changes.push(`${m.code} "${m.name}" amount ${money(m.amount)} → ${money(n.amount)}`); m.name = n.name; m.amount = n.amount; m.pct = n.pct; rescopeSimple(po, m); } });
    added.forEach(x => { const seq = Math.max(0, ...msOf(po).map(q => q.seq)) + 1; changes.push(`Added milestone M${seq} "${x.name}" ${money(x.amount)}`);
      const nm = makeMilestone(po, { ...x, id: undefined }, 0, { scopes: [simpleScope(po.lines, x.pct)], values: [simpleScope(po.lines, x.pct).map(q => sliceRaw(q, lineOf(po, q.lineId)))], amounts: [x.amount], pcts: [x.pct] });
      nm.seq = seq; nm.code = `M${seq}`; nm.amount = x.amount; nm.status = 'Pending'; nm.history = [{ at: nowISO(), by: actor(), role: db.meta.role, from: '', to: 'Pending', note: `Added by PO amendment v${po.version + 1}` }]; rescopeSimple(po, nm); db.milestones.push(nm); });
    msOf(po).forEach(m => { m.pct = after ? Math.round(m.amount / after * 1e8) / 1e6 : 0; });
  }
  if (po.billingMethod === 'Milestone') {
    /* rescheduling: due dates may move at any time (amounts of locked milestones never do); every move is logged */
    msOf(po).forEach(m => { const n = milestones.find(x => x.id === m.id); if (n && n.planned && n.planned !== m.planned) { changes.push(`${m.code} due date ${fmtD(m.planned)} → ${fmtD(n.planned)}`); (m.history = m.history || []).push({ at: nowISO(), by: actor(), role: db.meta.role, from: m.status, to: m.status, note: `Rescheduled ${fmtD(m.planned)} → ${fmtD(n.planned)} (PO amendment v${po.version + 1}: ${reason})` }); m.planned = n.planned; } });
  }
  return finishAmend(po, before, changes, reason);
};
/* edit one milestone's scope / gates / advance terms by amendment (spec 5.4.6: allowed only for slices with no reservation or invoice) */
const PATCH_FIELDS = ['name', 'scope', 'needsDoc', 'docTitle', 'docApproverRole', 'needsGrn', 'needsSrn', 'autoSrn', 'allowPartial', 'requireCompleteQty', 'needsGuarantee', 'guaranteeTitle', 'advance', 'trigger', 'measured'];
A.amendMilestone = (poId, msId, patch, reason) => {
  const po = getPO(poId), m = getMS(msId);
  if (!po || po.status !== 'Approved' || po.billingMethod !== 'Milestone' || !m || m.poId !== po.id) return NO('Only a milestone of an approved Milestone PO can be amended.');
  if (!String(reason || '').trim()) return NO('An amendment reason is required.');
  const locked = msLocked(m), errs = [], changes = [], editsScope = PATCH_FIELDS.some(k => patch[k] !== undefined);
  if (locked && editsScope) return NO(`${m.code} is ${usage('milestone', m.id).value > EPS ? 'invoiced' : m.status.toLowerCase()} — its scope, gates and advance terms are locked. Only the due date and dependencies can change.`);
  const cand = { ...m }; PATCH_FIELDS.forEach(k => { if (patch[k] !== undefined) cand[k] = patch[k]; });
  ['durationDays', 'forecastDate', 'depJoin', 'closing', 'planned', 'damages'].forEach(k => { if (patch[k] !== undefined) cand[k] = patch[k]; });
  if (patch.deps !== undefined) cand.deps = patch.deps.map(normDep); else if (patch.dependsOn) { cand.dependsOn = patch.dependsOn; delete cand.deps; }
  const all = msOf(po).map(x => x.id === m.id ? cand : x), idx = all.findIndex(x => x.id === m.id);
  const frozenKeys = [['planned', 'due date'], ['durationDays', 'duration'], ['deps', 'dependencies'], ['dependsOn', 'dependencies'], ['depJoin', 'join rule'], ['damages', 'delay damages']].filter(([k]) => patch[k] !== undefined && JSON.stringify(k === 'deps' ? patch.deps.map(normDep).map(({ legacy, ...r }) => r) : patch[k]) !== JSON.stringify(k === 'deps' ? depList(m).map(({ legacy, ...r }) => r) : (m[k] ?? (k === 'durationDays' ? 0 : k === 'depJoin' ? 'ALL' : k === 'damages' ? null : ''))));
  if (usage('milestone', m.id).value > EPS && frozenKeys.length) return NO(`${m.code} is already invoiced — its ${[...new Set(frozenKeys.map(x => x[1]))].join(' and ')} are frozen. Invoiced dates are never changed retroactively.`);
  if (patch.scope !== undefined) {
    cand.simple = false;
    cand.scope = (patch.scope || []).map(x => ({ lineId: x.lineId, basis: x.basis, ...(x.basis === 'quantity' ? { qty: +x.qty } : x.basis === 'percent' ? { percent: +x.percent } : { amount: +x.amount }) }));
    const sch = buildSchedule(po.lines, all.map(x => x === cand ? cand : { ...x, scope: (x.scope || []).map(q => ({ ...q })) }));
    sch.errors.filter(e => !/not assigned to any milestone/.test(e)).forEach(e => errs.push(e));
    if (!errs.length) { cand.scope = sch.scopes[idx].map((x, si) => ({ ...x, value: sch.values[idx][si] })); cand.amount = sch.amounts[idx]; cand.pct = sch.pcts[idx]; cand.simple = false; }
    const lost = [...(m.grnIds || []), ...(m.srnIds || [])].map(id => getGRN(id) || getSRN(id)).filter(r => r && !inScope(cand, r.lineId));
    lost.forEach(r => errs.push(`${r.number} is linked to ${m.code} but its line would leave the scope. Unlink it first.`));
    const c = advConsumedOn(m); if (!errs.length && cand.amount < c - EPS) errs.push(`${m.code} cannot be amended below ${money(c)}: invoiced ${money(usage('milestone', m.id).value)} plus unrecovered advance ${money(sum(advOfMs(m), a => advO(a)))}.`);
  }
  if (patch.advance !== undefined && advOfMs(m).some(a => !a.rejected)) errs.push(`${m.code} already has an advance — its terms are locked with the schedule.`);
  if (cand.needsGuarantee && !String(cand.guaranteeTitle || '').trim()) errs.push('Name the guarantee that Finance must verify.');
  if (cand.needsDoc && !String(cand.docTitle || '').trim()) errs.push('Name the document that must be approved.');
  if (cand.requireCompleteQty && !(cand.scope || []).some(x => x.basis === 'quantity')) errs.push('"Complete quantity" needs at least one scope row on a quantity basis.');
  if (cand.needsGrn && !hasGoods(po)) errs.push('The PO has no goods lines, so a GRN cannot be required.');
  if (cand.needsSrn && !hasServices(po)) errs.push('The PO has no services lines, so an SRN cannot be required.');
  depCodes(cand).forEach(c => { if (c === m.code) errs.push('A milestone cannot depend on itself.'); else if (!msOf(po).some(x => x.code === c)) errs.push(`Depends on ${c}, which does not exist.`); });
  { const cyc = depCycle(all.map(x => ({ ...x, code: x.code }))); if (cyc) errs.push(`Dependency cycle: ${cyc.join(' → ')}.`); }
  if (patch.trigger !== undefined || patch.scope !== undefined) trigErrors(po.lines, cand, m.code).forEach(e => errs.push(e));
  if (cand.closing && msOf(po).some(x => x.closing && x.id !== m.id)) errs.push(`${msOf(po).find(x => x.closing && x.id !== m.id).code} already closes the PO — only one milestone can.`);
  if (!errs.length && patch.advance !== undefined) advanceTermErrors({ lines: po.lines, settings: po.settings, milestones: all }, all.map(x => x.amount)).forEach(e => errs.push(e));
  if (errs.length) return NO(errs, 'Amendment rejected — see issues.');
  const before = poNet(po);
  if (patch.scope !== undefined) { changes.push(`${m.code} scope re-assigned${cand.amount !== m.amount ? `, amount ${money(m.amount)} → ${money(cand.amount)}` : ''}`); }
  ['name', 'needsDoc', 'docTitle', 'needsGrn', 'needsSrn', 'allowPartial', 'requireCompleteQty', 'needsGuarantee', 'guaranteeTitle'].forEach(k => { if (patch[k] !== undefined && patch[k] !== m[k]) changes.push(`${m.code} ${k} ${m[k]} → ${patch[k]}`); });
  if (patch.advance !== undefined) changes.push(`${m.code} advance terms ${patch.advance.allowed ? 'set' : 'removed'}`);
  Object.assign(m, { name: String(cand.name).trim(), scope: cand.scope, amount: cand.amount, pct: cand.pct, simple: cand.simple, needsDoc: !!cand.needsDoc, docTitle: cand.needsDoc ? (String(cand.docTitle || '').trim() || 'Supporting document') : '', docApproverRole: cand.docApproverRole || m.docApproverRole,
    needsGrn: !!cand.needsGrn || cand.scope.some(x => x.basis === 'quantity' && lineKind(po, lineOf(po, x.lineId)) === 'Goods'), needsSrn: !!cand.needsSrn || cand.scope.some(x => x.basis === 'quantity' && lineKind(po, lineOf(po, x.lineId)) === 'Services'),
    allowPartial: !!cand.allowPartial, requireCompleteQty: !!cand.requireCompleteQty, autoSrn: !!cand.autoSrn, needsGuarantee: !!cand.needsGuarantee, guaranteeTitle: cand.needsGuarantee ? (String(cand.guaranteeTitle || '').trim() || 'Performance bank guarantee') : '', advance: patch.advance !== undefined ? normAdvance(patch.advance) : m.advance });
  const impactBefore = msOf(po).map(x => msDateItem(x, po));
  if (patch.trigger !== undefined && JSON.stringify(patch.trigger || null) !== JSON.stringify(m.trigger || null)) changes.push(`${m.code} quantity trigger ${patch.trigger ? 'set to ' + fq(patch.trigger.qty) + ' cumulative' : 'removed'}`);
  if (patch.damages !== undefined && JSON.stringify(normDamages(patch.damages)) !== JSON.stringify(m.damages || null)) changes.push(`${m.code} delay damages ${patch.damages && +patch.damages.ratePct > 0 ? patch.damages.ratePct + '% per week, cap ' + (patch.damages.capPct || 10) + '%' : 'removed'}`);
  if (patch.planned !== undefined && patch.planned !== m.planned) { if (!m.originalPlanned) m.originalPlanned = m.planned; changes.push(`${m.code} due date ${m.planned ? fmtD(m.planned) : '—'} → ${patch.planned ? fmtD(patch.planned) : '—'}`); m.planned = patch.planned; }
  const hadDeps = JSON.stringify(depList(m)), hadDur = m.durationDays || 0;
  delete m.deps; Object.assign(m, depFields(cand));
  if (JSON.stringify(depList(m)) !== hadDeps) changes.push(`${m.code} dependencies ${depCodes(m).join(', ') || 'removed'}`);
  if ((m.durationDays || 0) !== hadDur) changes.push(`${m.code} duration ${hadDur} → ${m.durationDays} days`);
  depImpact(impactBefore, msOf(po).map(x => msDateItem(x, po)), po).forEach(r => changes.push(r.frozen ? `${r.code} is already invoiced — its dates are not recomputed` : `${r.code} forecast ${fmtD(r.from)} → ${fmtD(r.to)} (${r.days > 0 ? '+' : ''}${r.days}d)`));
  (m.history = m.history || []).push({ at: nowISO(), by: actor(), role: db.meta.role, from: m.status, to: m.status, note: `Amended (PO v${po.version + 1}): ${reason}` });
  return finishAmend(po, before, changes, reason);
};
A.amendAddMilestone = (poId, def, reason) => {
  const po = getPO(poId);
  if (!po || po.status !== 'Approved' || po.billingMethod !== 'Milestone') return NO('Milestones can be added only to an approved Milestone PO.');
  if (!String(reason || '').trim()) return NO('An amendment reason is required.');
  if (!String(def.name || '').trim()) return NO('Enter the milestone name.');
  const seq = Math.max(0, ...msOf(po).map(q => q.seq)) + 1, errs = [];
  const nm = { ...def, scope: (def.scope || []).map(x => ({ lineId: x.lineId, basis: x.basis, ...(x.basis === 'quantity' ? { qty: +x.qty } : x.basis === 'percent' ? { percent: +x.percent } : { amount: +x.amount }) })), code: `M${seq}` };
  if (!nm.scope.length) return NO('Add at least one line to the scope of the new milestone.');
  const all = [...msOf(po).map(x => ({ ...x, scope: (x.scope || []).map(q => ({ ...q })) })), nm], sch = buildSchedule(po.lines, all), idx = all.length - 1;
  sch.errors.filter(e => !/not assigned to any milestone/.test(e)).forEach(e => errs.push(e));
  if (nm.needsGrn && !hasGoods(po)) errs.push('The PO has no goods lines, so a GRN cannot be required.');
  if (nm.needsSrn && !hasServices(po)) errs.push('The PO has no services lines, so an SRN cannot be required.');
  depCodes(nm).forEach(c => { if (!msOf(po).some(x => x.code === c)) errs.push(`Depends on ${c}, which does not exist.`); });
  trigErrors(po.lines, nm, nm.code).forEach(e => errs.push(e));
  { const cyc = depCycle(all); if (cyc) errs.push(`Dependency cycle: ${cyc.join(' → ')}.`); }
  if (nm.closing && msOf(po).some(x => x.closing)) errs.push(`${msOf(po).find(x => x.closing).code} already closes the PO — only one milestone can.`);
  if (nm.needsGuarantee && !String(nm.guaranteeTitle || '').trim()) errs.push('Name the guarantee that Finance must verify.');
  if (nm.needsDoc && !String(nm.docTitle || '').trim()) errs.push('Name the document that must be approved.');
  if (errs.length) return NO(errs, 'Amendment rejected — see issues.');
  const m = makeMilestone(po, nm, idx, sch); m.seq = seq; m.code = `M${seq}`; m.status = 'Pending';
  m.history = [{ at: nowISO(), by: actor(), role: db.meta.role, from: '', to: 'Pending', note: `Added by PO amendment v${po.version + 1}: ${reason}` }];
  db.milestones.push(m);
  return finishAmend(po, poNet(po), [`Added milestone ${m.code} "${m.name}" ${money(m.amount)}`], reason);
};

/* ----- GRN (goods PO) ----- */
function finalizeGRN(g) {
  g.status = g.accepted >= g.received - EPS ? 'Accepted' : g.accepted > 0 ? 'Partially Accepted' : 'Rejected';
  g.inspection = g.status === 'Accepted' ? 'Passed' : g.status === 'Partially Accepted' ? 'Partially Passed' : 'Failed';
  g.decidedAt = nowISO(); g.decidedBy = actor();
}
/* d: { poId, lineId, date, received, rejected, remarks, attachments, milestoneId }  mode: 'accept' (delivered − rejected accepted now) | 'inspect' (goes to Pending Inspection) */
A.createGRN = (d, mode = 'accept') => {
  const received = +d.received || 0, rejected = mode === 'accept' ? (+d.rejected || 0) : 0;
  const n = { ...d, received, rejected, accepted: mode === 'accept' ? r2(received - rejected) : 0 };
  const errs = validateGRN(n);
  if (errs.length) return NO(errs);
  const po = getPO(d.poId), seq = db.grns.filter(g => g.poId === po.id).length + 1;
  const g = { id: uid('grn'), poId: po.id, lineId: d.lineId, seq, number: `GRN-${pad(seq)}`, date: d.date || todayISO(), received, accepted: n.accepted, rejected, inspection: 'Pending', remarks: d.remarks || '', attachments: d.attachments || [], status: 'Pending Inspection', reversed: false, milestoneId: null, createdBy: actor(), createdAt: nowISO() };
  db.grns.push(g);
  audit(po.id, g.number, `${g.number} created: ${fmtNum(g.received)} delivered${mode === 'accept' ? `, ${fmtNum(g.accepted)} accepted, ${fmtNum(g.rejected)} rejected` : ' — sent for inspection'}.`, 'grn');
  if (mode === 'accept') { finalizeGRN(g); audit(po.id, g.number, `${g.number} ${g.status.toLowerCase()}: ${fmtNum(g.accepted)} units are now invoice-eligible.`, g.status === 'Rejected' ? 'bad' : 'ok'); }
  if (d.milestoneId) A.msLinkReceipt(d.milestoneId, g.id, true, { cap: d.milestoneCap });
  save(); return OK(`${g.number} ${mode === 'accept' ? g.status.toLowerCase() : 'sent for inspection'}`, { id: g.id });
};
A.acceptGRN = id => {
  const g = getGRN(id); if (!g || g.status !== 'Pending Inspection') return NO('GRN is not awaiting inspection.');
  g.accepted = g.received; g.rejected = 0; finalizeGRN(g);
  audit(g.poId, g.number, `${g.number} accepted: ${fmtNum(g.accepted)} units now invoice-eligible.`, 'ok');
  save(); return OK(`${g.number} accepted`);
};
A.recordInspection = (id, accepted, rejected) => {
  const g = getGRN(id); if (!g || g.status !== 'Pending Inspection') return NO('GRN is not awaiting inspection.');
  accepted = +accepted || 0; rejected = +rejected || 0;
  if (accepted < 0 || rejected < 0) return NO('Quantities cannot be negative.');
  if (Math.abs(r2(accepted + rejected) - g.received) > EPS) return NO(`Accepted + rejected must equal the delivered quantity (${fmtNum(g.received)}).`);
  g.accepted = accepted; g.rejected = rejected; finalizeGRN(g);
  audit(g.poId, g.number, `Inspection completed on ${g.number}: ${fmtNum(accepted)} accepted, ${fmtNum(rejected)} rejected → ${g.status}.`, g.status === 'Rejected' ? 'bad' : 'ok'); save(); return OK(`${g.number} ${g.status.toLowerCase()}`);
};
A.rejectGRN = (id, reason) => {
  const g = getGRN(id); if (!g || g.status !== 'Pending Inspection') return NO('GRN is not awaiting inspection.');
  if (!String(reason || '').trim()) return NO('A rejection reason is required.');
  g.rejected = g.received; g.accepted = 0; g.status = 'Rejected'; g.inspection = 'Failed'; g.remarks = (g.remarks ? g.remarks + ' · ' : '') + 'Rejected: ' + reason;
  audit(g.poId, g.number, `${g.number} rejected: ${reason}`, 'bad'); save(); return OK(`${g.number} rejected`);
};
A.reverseGRN = (id, reason) => {
  const g = getGRN(id); if (!g || !GRN_OK.includes(g.status) || g.reversed) return NO('Only accepted GRNs can be reversed.');
  if (!String(reason || '').trim()) return NO('A reversal reason is required.');
  g.reversed = true; g.reverseReason = reason; g.reversedAt = nowISO();
  const hit = usage('grn', g.id), ms = g.milestoneId && getMS(g.milestoneId), po0 = getPO(g.poId);
  const failed = revalidateDependents(po0, 'grn', g.id, `${g.number} reversed`);
  audit(g.poId, g.number, `${g.number} reversed (${reason}). Eligible balance reduced by ${fmtNum(g.accepted)} units. History preserved.${failed.length ? ` Unposted invoices ${failed.map(invRef).join(', ')} failed re-matching and were released.` : ''}${hit.invs.some(i => APPROVED.includes(i.status) && !failed.includes(i)) ? ' Posted / approved invoices are preserved and flagged for AP review.' : ''}${ms ? ` Milestone ${ms.code} no longer has an accepted GRN.` : ''}`, 'bad');
  save(); return OK(`${g.number} reversed${failed.length ? ` — ${failed.length} invoice(s) failed re-matching` : ''}`);
};

/* ----- SRN (services PO) ----- */
/* d: { poId, lineId, date, description, serviceValue, remarks, attachments, milestoneId }  mode: 'accept' | 'submit' (pending acceptance) */
A.createSRN = (d, mode = 'submit') => {
  const n = { ...d, serviceValue: r2(d.serviceValue || 0) };
  const errs = validateSRN(n); if (errs.length) return NO(errs);
  const po = getPO(d.poId), seq = db.srns.filter(s => s.poId === po.id).length + 1;
  const s = { id: uid('srn'), poId: po.id, lineId: d.lineId, seq, number: `SRN-${pad(seq)}`, date: d.date || todayISO(), description: d.description.trim(), serviceValue: n.serviceValue, acceptedValue: 0, status: 'Pending Acceptance', remarks: d.remarks || '', attachments: d.attachments || [], milestoneId: null, createdBy: actor(), createdAt: nowISO() };
  db.srns.push(s);
  audit(po.id, s.number, `${s.number} created for ${money(s.serviceValue)} — pending acceptance.`, 'srn');
  if (mode === 'accept') A.acceptSRN(s.id, s.serviceValue, true);
  if (d.milestoneId) A.msLinkReceipt(d.milestoneId, s.id, true, { cap: d.milestoneCap });
  save(); return OK(`${s.number} ${mode === 'accept' ? 'accepted' : 'submitted for acceptance'}`, { id: s.id });
};
A.acceptSRN = (id, acceptedValue, quiet) => {
  const s = getSRN(id); if (!s || s.status !== 'Pending Acceptance') return NO('SRN is not awaiting acceptance.');
  const v = r2(acceptedValue ?? s.serviceValue);
  if (!(v > 0) || v > s.serviceValue + EPS) return NO(`Accepted value must be between 0 and ${money(s.serviceValue)}.`);
  s.acceptedValue = v; s.status = v >= s.serviceValue - EPS ? 'Accepted' : 'Partially Accepted'; s.decidedAt = nowISO(); s.decidedBy = actor();
  audit(s.poId, s.number, `${s.number} ${s.status.toLowerCase()} for ${money(v)}. Service receipt balance updated.${s.milestoneId ? ' (Milestone approval is a separate record and is unchanged.)' : ''}`, 'ok'); if (!quiet) save(); return OK(`${s.number} ${s.status.toLowerCase()}`);
};
A.rejectSRN = (id, reason) => {
  const s = getSRN(id); if (!s || s.status !== 'Pending Acceptance') return NO('SRN is not awaiting acceptance.');
  if (!String(reason || '').trim()) return NO('A rejection reason is required.');
  s.status = 'Rejected'; s.rejectReason = reason; audit(s.poId, s.number, `${s.number} rejected: ${reason}`, 'bad'); save(); return OK(`${s.number} rejected`);
};

A.reverseSRN = (id, reason) => {
  const x = getSRN(id); if (!x || !SRN_OK.includes(x.status) || x.reversed) return NO('Only accepted SRNs can be reversed.');
  if (!String(reason || '').trim()) return NO('A reversal reason is required.');
  x.reversed = true; x.reverseReason = reason; x.reversedAt = nowISO();
  const ms = x.milestoneId && getMS(x.milestoneId), failed = revalidateDependents(getPO(x.poId), 'srn', x.id, `${x.number} reversed`);
  audit(x.poId, x.number, `${x.number} reversed (${reason}). Accepted service value of ${money(x.acceptedValue)} withdrawn. History preserved.${failed.length ? ` Unposted invoices ${failed.map(invRef).join(', ')} failed re-matching and were released.` : ''}${ms ? ` Milestone ${ms.code} no longer has an accepted SRN.` : ''}`, 'bad');
  save(); return OK(`${x.number} reversed${failed.length ? ` — ${failed.length} invoice(s) failed re-matching` : ''}`);
};

/* ----- Milestones: Pending → In Progress → Submitted for Approval → Under Review → Approved | Rejected (→ resubmit) ----- */
const msRef = (po, m) => `${po.number} / ${m.code}`;
function msMove(m, po, to, note, kind) {
  (m.history = m.history || []).push({ at: nowISO(), by: actor(), role: db.meta.role, from: m.status, to, note: note || '' });
  m.status = to; audit(po.id, msRef(po, m), `Milestone ${m.code} "${m.name}" → ${to}${note ? ': ' + note : ''}.`, kind || 'ms');
}
/* segregation of duties (PRD UC-19): whoever submitted the evidence cannot review, approve or reject it. Demo Admin acts for every role and is exempt. */
const msSod = m => (db.meta.role !== 'admin' || !cfg().adminExemptFromSod) && m.submittedRole === db.meta.role ? NO(`Segregation of duties: ${m.submittedBy} submitted ${m.code}, so the same role cannot review or decide on it. Switch to another approver role.`) : null;
/* E16: advisory only — completing / approving M2 before M1 is allowed but flagged (hard dependency is a later decision) */
const msSeqWarn = (m, po) => {
  const deps = depsOf(m, po), early = deps.length ? deps.filter(x => msBilling(x, po) !== 'Invoiced') : msOf(po).filter(x => x.seq < m.seq && x.status !== 'Approved');
  return early.length ? `Out of sequence: ${early.map(x => x.code).join(', ')} ${early.length > 1 ? 'are' : 'is'} not ${deps.length ? 'invoiced' : 'approved'} yet.` : '';
};
/* E13: how long a submitted milestone has been waiting for its approver */
function msAging(m) {
  if (!msAwaiting(m) || !m.submittedAt) return null;
  const days = Math.floor((Date.now() - new Date(m.submittedAt).getTime()) / 864e5);
  return { days, level: days >= cfg().escalateAfterDays ? 'escalated' : days >= cfg().reminderAfterDays ? 'reminder' : 'ok' };
}
const msCtx = id => { const m = getMS(id), po = m && getPO(m.poId); return { m, po }; };
A.msStart = id => {
  const { m, po } = msCtx(id); if (!m || !po) return NO('Milestone not found.');
  if (po.status !== 'Approved') return NO('The PO must be approved first.');
  if (m.status !== 'Pending') return NO(`${m.code} is ${m.status} — only a Pending milestone can be started.`);
  { const dep = unmetDeps(m, po, 'start'); if (dep.length) return NO(depMsg(m, dep, depJoin(m)) + '.'); }
  msMove(m, po, 'In Progress', 'work started'); m.startedAt = nowISO(); m.startedBy = actor(); save(); return OK(`${m.code} is now in progress`);
};
/* files = the evidence the supplier uploads (mandatory when the milestone requires a document) */
A.msSubmit = (id, { actualDate, remarks, files } = {}) => {
  const { m, po } = msCtx(id); if (!m || !po) return NO('Milestone not found.');
  if (po.status !== 'Approved') return NO('The PO must be approved first.');
  if (!['Pending', 'In Progress', 'Rejected'].includes(m.status)) return NO(`${m.code} is ${m.status} — it cannot be submitted now.`);
  const errs = [], fl = files || [];
  if (!actualDate) errs.push('Completion date is required.');
  else if (actualDate > todayISO()) errs.push(`Completion date ${fmtD(actualDate)} is in the future.`);
  else if (po.poDate && actualDate < po.poDate) errs.push(`Completion date ${fmtD(actualDate)} is before the PO date ${fmtD(po.poDate)}.`);
  if (m.needsDoc && !fl.length) errs.push(`Upload the ${docTitleOf(m)} — it is mandatory for ${m.code}.`);
  if (errs.length) return NO(errs);
  const v = (m.submissions || []).length + 1, resub = m.status === 'Rejected';
  (m.submissions = m.submissions || []).push({ v, at: nowISO(), by: actor(), role: db.meta.role, files: [...fl], remarks: remarks || '', actualDate, status: 'Submitted' });
  Object.assign(m, { actualDate, remarks: remarks || '', evidence: [...fl], rejectReason: '', infoRequested: false, submittedBy: actor(), submittedRole: db.meta.role, submittedAt: nowISO(), reviewedBy: '', reviewedAt: '' });
  if (m.needsDoc) m.doc = { files: [...fl], remarks: remarks || '', status: 'Pending Approval', version: v, uploadedBy: actor(), uploadedRole: db.meta.role, uploadedAt: nowISO() };
  msMove(m, po, 'Submitted for Approval', `${resub ? 'resubmitted' : 'submitted'} (submission ${v}) with ${fl.length} file(s)${m.needsDoc ? ' incl. the ' + docTitleOf(m) : ''}`);
  save(); return OK(`${m.code} ${resub ? 'resubmitted' : 'submitted'} for approval`);
};
A.msStartReview = id => {
  const { m, po } = msCtx(id); if (!m || !po) return NO('Milestone not found.');
  if (m.status !== 'Submitted for Approval') return NO(`${m.code} is ${m.status} — there is nothing waiting to be reviewed.`);
  const sod = msSod(m); if (sod) return sod;
  m.reviewedBy = actor(); m.reviewedAt = nowISO(); msMove(m, po, 'Under Review', 'review started'); save(); return OK(`${m.code} is now under review`);
};
A.msApprove = (id, note) => {
  const { m, po } = msCtx(id); if (!m || !po) return NO('Milestone not found.');
  if (po.status !== 'Approved') return NO('The PO must be approved first.');
  if (!['Submitted for Approval', 'Under Review'].includes(m.status)) return NO(`${m.code} is ${m.status} — only a submitted milestone can be approved.`);
  const sod = msSod(m); if (sod) return sod;
  { const dep = unmetDeps(m, po, 'approve'); if (dep.length) return NO(depMsg(m, dep, depJoin(m)) + '.'); }
  { const cb = closingBlock(m, po); if (cb) return NO(cb); }
  if (!m.reviewedBy) { m.reviewedBy = actor(); m.reviewedAt = nowISO(); }
  m.approvedAt = nowISO(); m.approvedBy = actor(); m.rejectReason = '';
  const last = (m.submissions || [])[(m.submissions || []).length - 1]; if (last) Object.assign(last, { status: 'Approved', decidedBy: actor(), decidedAt: nowISO() });
  if (m.needsDoc && m.doc) Object.assign(m.doc, { status: 'Approved', decidedBy: actor(), decidedAt: nowISO(), rejectReason: '' });
  m.infoRequested = false;
  const auto = m.autoSrn ? autoSrnOnApproval(m, po) : [];
  const g = msGate(m, po), warn = msSeqWarn(m, po);
  msMove(m, po, 'Approved', `${note ? note + ' — ' : ''}${auto.length ? `system SRN ${auto.map(x => x.number).join(', ')} auto-created for the service slice(s) — ` : ''}${g.ok ? money(m.amount) + ' is now invoice-eligible' : 'still blocked for invoicing: ' + g.reason}${warn ? ' · ' + warn : ''}`, 'ok'); save();
  return OK((g.ok ? `${m.code} approved — ${money(m.amount)} is now invoice-eligible` : `${m.code} approved — invoicing stays blocked until: ${g.reason}`) + (warn ? ` (${warn})` : ''));
};
/* approver asks the supplier for more information instead of rejecting outright (PRD Flow 5 alternate, UC27): the supplier resubmits and history keeps both submissions */
A.msRequestInfo = (id, note) => {
  const { m, po } = msCtx(id); if (!m || !po) return NO('Milestone not found.');
  if (!msAwaiting(m)) return NO(`${m.code} is ${m.status} — only a submitted milestone can have information requested.`);
  if (!String(note || '').trim()) return NO('Say what information is needed.');
  const sod = msSod(m); if (sod) return sod;
  const last = (m.submissions || [])[(m.submissions || []).length - 1]; if (last) Object.assign(last, { status: 'Info Requested', decidedBy: actor(), decidedAt: nowISO(), reason: note });
  if (m.needsDoc && m.doc) Object.assign(m.doc, { status: 'Rejected', decidedBy: actor(), decidedAt: nowISO(), rejectReason: 'Information requested: ' + note });
  m.rejectReason = 'Information requested: ' + note; m.infoRequested = true; msMove(m, po, 'Rejected', 'Information requested: ' + note, 'bad'); save();
  return OK(`${m.code} returned to the supplier — information requested`);
};
/* Decision 4 (optional per milestone): a SERVICE milestone may auto-create a system SRN for its service slices when approved, so three-way matching stays consistent. Goods always need a real GRN. */
function autoSrnOnApproval(m, po) {
  const made = [];
  sliceInfo(m, po).filter(x => x.kind === 'Services').forEach(x => {
    const need = x.basis === 'quantity' ? r2(x.value - x.acc) : ((m.srnIds || []).map(getSRN).some(q => q && q.lineId === x.line.id && srnEnt(q) > 0) ? 0 : x.value);
    if (!(need > EPS)) return;
    const r = A.createSRN({ poId: po.id, lineId: x.line.id, date: todayISO(), description: `System SRN — ${m.code} "${m.name}" approved`, serviceValue: need, milestoneId: m.id, milestoneCap: x.basis === 'quantity' ? need : undefined }, 'accept');
    if (r.ok) { const q = getSRN(r.id); q.system = true; q.createdBy = 'System (auto-created on milestone approval)'; made.push(q); }
    else audit(po.id, msRef(po, m), `Auto-SRN for ${x.line.desc} skipped: ${r.errors[0]}`, 'bad');
  });
  return made;
}
A.msReject = (id, reason) => {
  const { m, po } = msCtx(id); if (!m || !po) return NO('Milestone not found.');
  if (!['Submitted for Approval', 'Under Review'].includes(m.status)) return NO(`${m.code} is ${m.status} — only a submitted milestone can be rejected.`);
  if (!String(reason || '').trim()) return NO('A rejection reason is required.');
  const sod = msSod(m); if (sod) return sod;
  const last = (m.submissions || [])[(m.submissions || []).length - 1]; if (last) Object.assign(last, { status: 'Rejected', decidedBy: actor(), decidedAt: nowISO(), reason });
  if (m.needsDoc && m.doc) Object.assign(m.doc, { status: 'Rejected', decidedBy: actor(), decidedAt: nowISO(), rejectReason: reason });
  m.rejectReason = reason; m.infoRequested = false; msMove(m, po, 'Rejected', reason, 'bad'); save(); return OK(`${m.code} rejected — the supplier can resubmit`);
};
/* link a GRN / SRN to a milestone. A receipt backs one milestone; it may back several only when every link carries an explicit quantity (and the quantities fit the receipt). */
A.msLinkReceipt = (msId, recId, quiet, opts = {}) => {
  const { m, po } = msCtx(msId); if (!m) return NO('Milestone not found.');
  const g = getGRN(recId), sn = g ? null : getSRN(recId), r = g || sn, kind = g ? 'grn' : 'srn', L = kind.toUpperCase();
  if (!r || r.poId !== po.id) return NO(`Select a GRN / SRN that belongs to this PO.`);
  if (!(kind === 'grn' ? m.needsGrn || (m.scope || []).some(x => x.basis === 'quantity') : m.needsSrn || (m.scope || []).some(x => x.basis === 'quantity'))) return NO(`${m.code} is not configured to require a ${L}.`);
  if (!inScope(m, r.lineId)) { const l = lineOf(po, r.lineId); return NO(`Line ${l ? l.no : '?'} (${l ? l.desc : ''}) is not in the scope of ${m.code}, so ${r.number} cannot back it.`); }
  if (usage('milestone', m.id).value > EPS && hardReceiptGate(m, po)) return NO(`${m.code} already has invoices against it — a new ${L} can no longer be linked.`);
  if (r.reversed || r.status === 'Rejected') return NO(`${r.number} is ${r.reversed ? 'reversed' : 'rejected'} and cannot back a milestone.`);
  const cap = +opts.cap > 0 ? r2(+opts.cap) : null, links = linksOf(r);
  if (links.some(x => x.msId === m.id)) return NO(`${r.number} is already linked to ${m.code}.`);
  if (links.length) {
    const other = getMS(links[0].msId);
    if (cap == null || links.some(x => x.cap == null)) return NO(`${r.number} is already linked to ${other ? other.code : 'another milestone'}. To let one receipt back several milestones, give every link an explicit ${kind === 'grn' ? 'quantity' : 'value'}.`);
    const limit = kind === 'grn' ? r.received : r.serviceValue, total = r2(sum(links, x => x.cap) + cap);
    if (total > limit + EPS) return NO(`The links on ${r.number} would allocate ${fq(total)} but the receipt only has ${fq(limit)}${kind === 'grn' ? ' ' + (lineOf(po, r.lineId) || {}).uom : ''}. No unit can back two milestones.`);
  }
  r.links = [...links, { msId: m.id, cap }]; r.milestoneId = r.links[0].msId;
  (kind === 'grn' ? (m.grnIds = m.grnIds || []) : (m.srnIds = m.srnIds || [])).push(r.id);
  audit(po.id, msRef(po, m), `Milestone ${m.code} linked to ${r.number} (${r.reversed ? 'Reversed' : r.status})${cap != null ? ` for ${fq(cap)}` : ''}.`, 'ms');
  if (!quiet) save(); return OK(`Linked ${r.number} to ${m.code}`);
};
A.msUnlinkReceipt = (msId, recId) => {
  const { m, po } = msCtx(msId); if (!m) return NO('Milestone not found.');
  if (usage('milestone', m.id).value > EPS) return NO(`${m.code} already has invoices against it — its receipts can no longer be unlinked.`);
  const r = getGRN(recId) || getSRN(recId); if (!r) return NO('Receipt not found.');
  m.grnIds = (m.grnIds || []).filter(x => x !== recId); m.srnIds = (m.srnIds || []).filter(x => x !== recId);
  r.links = linksOf(r).filter(x => x.msId !== m.id); r.milestoneId = r.links.length ? r.links[0].msId : null;
  audit(po.id, msRef(po, m), `${r.number} unlinked from milestone ${m.code}.`, 'ms'); save(); return OK(`${r.number} unlinked`);
};

/* ----- Delegation of approvals (E14) ----- */
A.addDelegation = (from, to, until) => {
  if (!ROLES[from] || !ROLES[to] || from === 'admin' || to === 'admin') return NO('Choose two different roles.');
  if (from === to) return NO('A role cannot delegate to itself.');
  if (until && until < todayISO()) return NO('The delegation end date is in the past.');
  const list = (db.meta.delegations = db.meta.delegations || []);
  if (list.some(d => d.from === from && d.to === to && (!d.until || d.until >= todayISO()))) return NO(`${ROLES[from].name} already delegates to ${ROLES[to].name}.`);
  list.push({ id: uid('dg'), from, to, until: until || '', at: nowISO(), by: actor() });
  audit('', 'Delegation', `${ROLES[from].name} delegated approvals to ${ROLES[to].name}${until ? ' until ' + fmtD(until) : ''}. Pending items are now visible to the delegate; earlier approvals stay valid.`, 'ok'); save(); return OK('Delegation added');
};
A.removeDelegation = id => { const list = db.meta.delegations || [], d = list.find(x => x.id === id); if (!d) return NO('Delegation not found.'); db.meta.delegations = list.filter(x => x.id !== id); audit('', 'Delegation', `Delegation from ${ROLES[d.from].name} to ${ROLES[d.to].name} ended.`, 'info'); save(); return OK('Delegation removed'); };

/* ----- Certified progress claims (Services POs, tracked at PO level) ----- */
A.createClaim = d => {
  const po = getPO(d.poId); if (!po || !poCertified(po)) return NO('Select a Services PO that bills on certified work progress.');
  if (po.status !== 'Approved') return NO(`${po.number} is ${po.status}. Claims can only be raised against an approved PO.`);
  const contract = poNet(po), prev = cumCertified(po), errs = [];
  const cum = r2(d.claimedCum);
  if (!String(d.period || '').trim()) errs.push('Enter the claim period.');
  if (db.claims.some(c => c.poId === po.id && c.status === 'Submitted')) errs.push('An earlier claim is still awaiting certification. Certify or reject it before raising the next one.');
  if (!(cum > prev + EPS)) errs.push(`New cumulative claimed value must be greater than the previously certified cumulative value (${money(prev)}). The vendor must not re-claim value that is already certified.`);
  if (cum > contract + EPS) errs.push(`Cumulative claimed value ${money(cum)} exceeds the PO value ${money(contract)}.`);
  if (!(d.evidence || []).length) errs.push('Attach supporting evidence (measurement sheets / site reports).');
  if (errs.length) return NO(errs);
  const seq = db.claims.filter(c => c.poId === po.id).length + 1;
  const c = { id: uid('pc'), poId: po.id, seq, number: `PC-${pad(seq)}`, period: d.period, prevCum: prev, claimedCum: cum, certified: 0, evidence: d.evidence || [], status: 'Submitted', remarks: d.remarks || '', createdAt: nowISO() };
  db.claims.push(c);
  audit(po.id, c.number, `${c.number} submitted for certification: cumulative ${money(cum)} − previously certified ${money(prev)} = current claim ${money(cum - prev)}.`, 'claim'); save();
  return OK(`${c.number} submitted for certification`, { id: c.id });
};
A.certifyClaim = (id, value) => {
  const c = getClaim(id); if (!c || c.status !== 'Submitted') return NO('Claim is not awaiting certification.');
  const po = getPO(c.poId), prev = cumCertified(po, c.id), cur = r2(c.claimedCum - prev), v = r2(value ?? cur);
  if (!(cur > EPS)) return NO('Nothing left to certify — the claimed cumulative value is already covered by earlier certificates.');
  if (!(v > 0) || v > cur + EPS) return NO(`Certified value must be between 0 and the current claim ${money(cur)} (cumulative ${money(c.claimedCum)} − previously certified ${money(prev)}).`);
  c.prevCum = prev; c.certified = v; c.status = 'Certified'; c.certifiedAt = nowISO(); c.certifiedBy = actor();
  audit(po.id, c.number, `${c.number} certified for ${money(v)} (cumulative certified now ${money(prev + v)}). Only this newly certified, unconsumed value is invoice-eligible.`, 'ok'); save(); return OK(`${c.number} certified for ${money(v)}`);
};
A.rejectClaim = (id, reason) => { const c = getClaim(id); if (!c || c.status !== 'Submitted') return NO('Claim is not awaiting certification.'); if (!String(reason || '').trim()) return NO('A rejection reason is required.'); c.status = 'Rejected'; c.rejectReason = reason; audit(c.poId, c.number, `${c.number} rejected: ${reason}`, 'bad'); save(); return OK(`${c.number} rejected`); };

/* ----- Invoices ----- */
function setLive(inv, wasLive) {
  const now = isLive(inv);
  if (now && !wasLive) inv.allocs.forEach(a => audit(inv.poId, invRef(inv), `Allocation reserved: ${allocText(a)} → ${invRef(inv)}.`, 'alloc'));
  if (!now && wasLive) inv.allocs.forEach(a => audit(inv.poId, invRef(inv), `Allocation released: ${allocText(a)} returned to eligible balance (${invRef(inv)} ${inv.status}).`, 'alloc'));
}
function allocText(a) {
  const src = a.kind === 'grn' ? getGRN(a.refId) : a.kind === 'srn' ? getSRN(a.refId) : a.kind === 'milestone' ? getMS(a.refId) : a.kind === 'advance' ? getAdv(a.refId) : getClaim(a.refId);
  const l = a.kind === 'milestone' ? src.code : src.number;
  return a.kind === 'grn' ? `${fmtNum(a.qty)} units of ${l} (${money(a.value)})` : `${money(a.value)} of ${l}`;
}
function setStatus(inv, to, note) {
  const was = isLive(inv), from = inv.status; inv.status = to; setLive(inv, was);
  inv.history.push({ at: nowISO(), by: actor(), from, to, note: note || '' });
}
A.saveInvoice = (d, mode) => {                  // mode: 'draft' | 'submit'
  const po = getPO(d.poId), errs = [];
  if (!po) return NO('Select a purchase order.');
  if (d.idemKey) {                                                  // E22: a double-click or network retry returns the invoice already created for this submission
    const prior = db.invoices.find(i => i.idemKey === d.idemKey);
    if (prior && !['Draft', 'Matching Failed'].includes(prior.status)) return OK(`${invRef(prior)} was already submitted`, { id: prior.id, duplicate: true });
    if (prior && !d.id) d = { ...d, id: prior.id };
  }
  if (!poAllocatable(po)) return NO(`${po.number} is ${po.status}. Only approved POs can be invoiced.`);
  const b = buildInvoice({ ...d, supplierId: po.supplierId, method: po.billingMethod });
  if (!String(b.number || '').trim()) errs.push('Enter the bill number.');
  if (!b.date) errs.push('Enter the bill date.');
  else if (b.date > todayISO()) errs.push(`Bill date ${fmtD(b.date)} is in the future.`);
  else if (po.poDate && b.date < po.poDate) errs.push(`Bill date ${fmtD(b.date)} is before the PO date ${fmtD(po.poDate)}.`);
  if (b.dueDate && b.date && b.dueDate < b.date) errs.push('Due date cannot be before the bill date.');
  if (!b.dueDate && b.dueSplit) b.dueDate = b.dueSplit.earliest;
  if (d.discountPct !== '' && d.discountPct != null && (+d.discountPct < 0 || +d.discountPct > 100)) errs.push('Discount percent must be between 0 and 100.');
  const ca = (d.costAlloc && d.costAlloc.rows || []).filter(r => r.dept || +r.pct);
  if (ca.length && Math.abs(sum(ca, r => +r.pct) - 100) > 0.0001) errs.push(`Cost allocation percentages total ${fmtNum(sum(ca, r => +r.pct))}% — they must total 100%.`);
  if (mode === 'submit') {
    const ae = allocErrors(b);
    if (ae.length && d.snap) {                                      // E21: balances moved since the screen was loaded → say so, then show the refreshed reasons
      const cur = sourceItems(po, d.id), moved = Object.entries(d.snap).some(([k, was]) => { const [kind, ...rest] = k.split(':'), it = cur.find(x => x.kind === kind && x.refId === rest.join(':')); return it && Math.abs((kind === 'grn' ? it.availQty : it.availValue) - was) > EPS; });
      if (moved) errs.push('Balances changed while you were editing. Review the refreshed amounts and resubmit.');
    }
    ae.forEach(e => errs.push(e.msg));
  }
  else if (!(b.net > 0)) errs.push('Enter an amount or allocation before saving.');
  if (errs.length) return NO(errs, mode === 'submit' ? 'Submission blocked by the validation gate.' : 'Cannot save draft.');
  let inv = d.id && getInv(d.id);
  if (inv && !['Draft', 'Matching Failed'].includes(inv.status)) return NO('Only draft or failed invoices can be edited.');
  if (!inv) {
    db.seq.inv += 1;
    inv = { id: uid('inv'), seq: db.seq.inv, ref: `INV-${pad(db.seq.inv, 4)}`, status: 'Draft', history: [], approvals: [], createdAt: nowISO(), createdBy: actor() };
    db.invoices.push(inv);
  }
  const was = isLive(inv);
  if (d.idemKey) inv.idemKey = d.idemKey;
  Object.assign(inv, { number: b.number.trim(), supplierId: po.supplierId, poId: po.id, method: po.billingMethod, date: b.date, dueDate: b.dueDate || '', net: b.net, gstRate: b.gstRate, discountPct: b.discountPct, discount: b.discount, gst: b.gst, tcs: b.tcs, roundOff: b.roundOff, gross: b.gross, gstCredit: !!d.gstCredit, createAsn: !!d.createAsn, costAlloc: d.costAlloc || { type: '', rows: [] }, remarks: d.remarks || '', attachments: d.attachments || [], allocs: b.allocs.map(a => ({ id: a.id || uid('al'), kind: a.kind, refId: a.refId, qty: a.qty ?? null, value: a.value, ...(a.recOrder && a.recOrder.length ? { recOrder: [...a.recOrder] } : {}), ...(a.lines && a.lines.length ? { lines: a.lines.map(x => ({ lineId: x.lineId, value: r2(x.value), qty: x.qty ?? null, ...(x.rate != null && x.rate !== '' ? { rate: +x.rate } : {}), ...(x.uom ? { uom: x.uom } : {}), ...(x.gstRate != null && x.gstRate !== '' ? { gstRate: +x.gstRate } : {}) })) } : {}) })), recovery: b.recovery, damages: b.damages, taxMixed: b.taxMixed, gstCalc: b.gstCalc, dueSplit: b.dueSplit, advanceId: b.advanceId || null, tdsDeducted: b.tdsDeducted || 0 });
  if (inv.advanceId && getAdv(inv.advanceId)) getAdv(inv.advanceId).invoiceId = inv.id;
  if (mode === 'draft') { audit(po.id, invRef(inv), `${invRef(inv)} saved as draft (no allocation reserved).`, 'inv'); save(); return OK(`${invRef(inv)} saved as draft`, { id: inv.id }); }
  inv.submittedAt = nowISO();
  inv.allocs.forEach(a => { delete a.trace; }); { const tr = allocTrace(inv); inv.allocs.forEach(a => { a.trace = tr.filter(r => r.allocId === a.id || (r.refId === a.refId && a.kind === 'milestone')); }); }   // I07: the receipt feeding is locked once the invoice is submitted
  setStatus(inv, 'Submitted', 'Submitted by vendor'); audit(po.id, invRef(inv), `${invRef(inv)} (bill no. ${inv.number}) submitted for ${money(inv.gross)} total.`, 'inv');
  setStatus(inv, 'Pending Matching');
  if (d.autoMatch !== false) A.runMatching(inv.id, true);
  save(); return OK(`${invRef(inv)} submitted`, { id: inv.id });
};
A.expireStaleInvoices = (hours = cfg().reservationTimeoutHours) => {
  const cut = Date.now() - hours * 36e5; let n = 0;
  db.invoices.forEach(i => { if (['Submitted', 'Pending Matching'].includes(i.status) && !i.reversed && new Date(i.submittedAt || i.createdAt).getTime() < cut) {
    setStatus(i, 'Matching Failed', `Timed out after ${hours}h in ${i.status}`); audit(i.poId, invRef(i), `${invRef(i)} stayed in ${i.history[i.history.length - 2]?.to || 'matching'} for more than ${hours}h — moved to Matching Failed and its allocation released.`, 'bad'); n++; } });
  if (n) save(); return n;
};
A.runMatching = (id, quiet) => {
  const inv = getInv(id); if (!inv) return NO('Invoice not found.');
  if (!['Submitted', 'Pending Matching', 'Matching Failed', 'Pending Approval'].includes(inv.status)) return NO(`Matching cannot run on a ${inv.status} invoice.`);
  refreshRecovery(inv);
  const ev = evaluateInvoice({ ...inv, allocs: inv.allocs });
  inv.match = { at: nowISO(), by: actor(), result: ev.result, checks: ev.checks };
  const target = ev.result === 'Blocked' ? 'Matching Failed' : 'Pending Approval';
  if (inv.status !== target) setStatus(inv, target, `Matching: ${ev.result}`);
  audit(inv.poId, invRef(inv), `Matching run on ${invRef(inv)}: ${ev.result}${ev.result === 'Blocked' ? ' — ' + ev.checks.filter(c => c.status === 'fail').map(c => c.label).join(', ') : '. Routed to AP Manager approval.'}`, ev.result === 'Blocked' ? 'bad' : 'ok');
  if (!quiet) save();
  return OK(ev.result === 'Blocked' ? 'Matching failed — invoice blocked' : `Matching ${ev.result.toLowerCase()} — routed for approval`, { result: ev.result });
};
A.approveInvoice = (id, note) => {
  const inv = getInv(id); if (!inv || inv.status !== 'Pending Approval') return NO('Invoice is not pending approval.');
  refreshRecovery(inv);                                        // advance recovery is recomputed from today's balances
  const ev = evaluateInvoice(inv);                             // re-validate against the live balances
  if (ev.result === 'Blocked') { inv.match = { at: nowISO(), by: actor(), result: ev.result, checks: ev.checks }; setStatus(inv, 'Matching Failed', 'Re-validation at approval failed'); audit(inv.poId, invRef(inv), `Approval blocked: re-validation failed — ${ev.checks.filter(c => c.status === 'fail').map(c => c.detail).join(' ')}`, 'bad'); save(); return NO(ev.checks.filter(c => c.status === 'fail').map(c => c.detail), 'Approval blocked — invoice no longer matches current balances.'); }
  setStatus(inv, 'Approved', note); inv.approvals.push({ at: nowISO(), by: actor(), action: 'Approved', note: note || '' });
  audit(inv.poId, invRef(inv), `${invRef(inv)} approved by AP Manager${note ? ': ' + note : ''}.`, 'ok'); save(); return OK(`${invRef(inv)} approved`);
};
A.rejectInvoice = (id, reason) => {
  const inv = getInv(id); if (!inv || inv.status !== 'Pending Approval') return NO('Invoice is not pending approval.');
  if (!String(reason || '').trim()) return NO('A rejection reason is required.');
  const blk = advBlock(inv); if (blk) return NO(blk);
  setStatus(inv, 'Rejected', reason); inv.approvals.push({ at: nowISO(), by: actor(), action: 'Rejected', note: reason });
  audit(inv.poId, invRef(inv), `${invRef(inv)} rejected: ${reason}`, 'bad'); save(); return OK(`${invRef(inv)} rejected — allocations released`);
};
A.cancelInvoice = (id, reason) => {
  const inv = getInv(id); if (!inv || !['Draft', 'Submitted', 'Pending Matching', 'Matching Failed', 'Pending Approval', 'Approved'].includes(inv.status)) return NO('This invoice can no longer be cancelled (post-AP reversals use credit notes).');
  const blk = advBlock(inv); if (blk) return NO(blk);
  setStatus(inv, 'Cancelled', reason); audit(inv.poId, invRef(inv), `${invRef(inv)} cancelled${reason ? ': ' + reason : ''}.`, 'bad'); save(); return OK(`${invRef(inv)} cancelled`);
};
A.postInvoice = id => {
  const inv = getInv(id); if (!inv || inv.status !== 'Approved') return NO('Only approved invoices can be posted to AP.');
  db.seq.apv += 1; inv.ap = { postedAt: nowISO(), postedBy: actor(), voucher: `APV-2026-${pad(db.seq.apv, 4)}` };
  setStatus(inv, 'Posted', 'Simulated AP posting'); audit(inv.poId, invRef(inv), `${invRef(inv)} posted to AP as ${inv.ap.voucher} (simulated — no ERP update).`, 'ok'); save(); return OK(`Posted as ${inv.ap.voucher} (simulated)`);
};
A.payInvoice = id => {
  const inv = getInv(id); if (!inv || inv.status !== 'Posted') return NO('Only posted invoices can be marked as paid.');
  db.seq.pay += 1; inv.ap.paidAt = nowISO(); inv.ap.payRef = `DEMO-PAY-${pad(db.seq.pay, 4)}`;
  setStatus(inv, 'Paid', 'Marked paid for demo'); audit(inv.poId, invRef(inv), `${invRef(inv)} marked as paid (demo only — no bank payment executed), ref ${inv.ap.payRef}.`, 'ok'); save(); return OK(`${invRef(inv)} marked paid (demo)`);
};
/* Posted / paid invoices are never deleted: a reversal issues a full credit note and RELEASES the allocation back to the receipt / milestone balance (PRD §12.2: Committed → Reversed) */
A.reverseInvoice = (id, reason) => {
  const inv = getInv(id); if (!inv || !['Posted', 'Paid'].includes(inv.status) || inv.reversed) return NO('Only a posted or paid invoice that has not been reversed can be reversed. Earlier invoices are cancelled or rejected instead.');
  if (!String(reason || '').trim()) return NO('A reversal reason is required.');
  const blk = advBlock(inv); if (blk) return NO(blk);
  const amt = payable(inv); if (amt > EPS) db.adjustments.push({ id: uid('adj'), invoiceId: inv.id, type: 'Credit', amount: amt, reason: `Reversal: ${reason}`, at: nowISO(), by: actor() });
  inv.reversed = { at: nowISO(), by: actor(), reason }; inv.history.push({ at: nowISO(), by: actor(), from: inv.status, to: inv.status + ' (reversed)', note: reason });
  inv.allocs.forEach(a => audit(inv.poId, invRef(inv), `Allocation reversed: ${allocText(a)} returned to the eligible balance (${invRef(inv)} reversed by credit note — ${reason}).`, 'alloc'));
  audit(inv.poId, invRef(inv), `${invRef(inv)} reversed via credit note of ${money(amt)}: ${reason}.`, 'bad'); save(); return OK(`${invRef(inv)} reversed — allocations released`);
};
A.addAdjustment = (id, { type, amount, reason, variationRef }) => {
  const inv = getInv(id); if (!inv || !APPROVED.includes(inv.status)) return NO('Adjustments apply to approved, posted or paid invoices.');
  amount = r2(amount); if (!(amount > 0)) return NO('Enter an amount greater than zero.'); if (!String(reason || '').trim()) return NO('A reason is required.');
  if (inv.advanceId && type === 'Credit') { /* a credit note never reduces the advance — only a refund does */ }
  if (type === 'Credit' && amount > payable(inv) + EPS) return NO(`Credit note cannot exceed the payable amount ${money(payable(inv))}.`);
  if (type === 'Debit') { const e = debitNoteErrors(inv, amount, variationRef); if (e) return NO(e); }
  db.adjustments.push({ id: uid('adj'), invoiceId: inv.id, type, amount, reason, ...(variationRef ? { variationRef } : {}), at: nowISO(), by: actor() });
  audit(inv.poId, invRef(inv), `${type} note of ${money(amount)} recorded against ${invRef(inv)} (${reason}). Receipt/milestone entitlements are NOT restored automatically.`, 'inv'); save(); return OK(`${type} note recorded`);
};
