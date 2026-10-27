/* Invoice-linking suite (brief I01–I18). Runs after core + logic + advances + seed (see build-and-run.js). */
let dfails = 0, dcount = 0;
const S = (name, ok, extra) => { dcount++; if (!ok) dfails++; console.log((ok ? 'PASS ' : 'FAIL ') + 'LINK ' + name + (ok || extra === undefined ? '' : '  :: ' + JSON.stringify(extra))); };
const lineDef = (desc, qty, price, o = {}) => ({ desc, qty, uom: o.uom || 'Units', price, kind: o.kind || 'Goods', outside: !!o.outside });
function mk(o) {
  const lines = o.lines.map(l => ({ ...l })); ensureLineIds(lines);
  const d = { id: null, supplierId: 'sup1', buyer: 'DICE', office: 'o-6225', title: 'Dep PO', poDate: o.poDate || todayISO(), deliveryDate: daysFromNow(60), endDate: '', type: o.type || 'Goods', category: o.category || 'Corporate Assets', gstRate: 18, billingMethod: 'Milestone', progressBasis: 'Receipt', lines, settings: o.settings,
    milestones: o.ms.map(m => ({ name: m.name || 'M', pct: m.pct, planned: daysFromNow(10), ...m, ...(m.scope ? { simple: false, scope: m.scope.map(x => ({ lineId: lines[x.lineIdx].id, basis: x.basis, ...(x.basis === 'percent' ? { percent: x.v } : x.basis === 'amount' ? { amount: x.v } : { qty: x.v }) })) } : {}), ...(m.trigger ? { trigger: { lineId: lines[m.trigger.lineIdx].id, qty: m.trigger.qty } } : {}) })) };
  const r = A.savePO(d, true); if (!r.ok) throw new Error('mk: ' + JSON.stringify(r.errors));
  if (!A.approvePO(r.id).ok) return { err: ['approve'] };
  return { po: getPO(r.id) };
}
let bn = 0;
const subm = (po, allocs, extra = {}) => A.saveInvoice({ poId: po.id, number: extra.number || 'D-' + (++bn), date: todayISO(), allocs, attachments: [], ...extra }, 'submit');
const approveMs = m => { A.msStart(m.id); A.msSubmit(m.id, { actualDate: todayISO(), files: ['f.pdf'] }); return A.msApprove(m.id); };
const ma = (m, v) => ({ kind: 'milestone', refId: m.id, qty: null, value: v ?? m.amount });
const sm = (po, allocs) => { const r = subm(po, allocs); if (!r.ok) throw new Error('subm: ' + JSON.stringify(r.errors)); return getInv(r.id); };
const L1 = [lineDef('Goods', 100, 1000)];
const dp = (pred, o = {}) => ({ pred, type: 'FS', lag: 0, effect: 'schedule', state: 'approved', ...o });
seedDb('default');
const approveToday = m => approveMs(getMS(m.id));
const grn = (po, lineIdx, n, date, extra = {}) => { const r = A.createGRN({ poId: po.id, lineId: po.lines[lineIdx].id, date: date || todayISO(), received: n, rejected: 0, ...extra }, 'accept'); if (!r.ok) throw new Error('grn ' + JSON.stringify(r.errors)); return getGRN(r.id); };
const srn = (po, lineIdx, v, extra = {}) => { const r = A.createSRN({ poId: po.id, lineId: po.lines[lineIdx].id, date: todayISO(), description: 'svc', serviceValue: v, ...extra }, 'accept'); if (!r.ok) throw new Error('srn ' + JSON.stringify(r.errors)); return getSRN(r.id); };
const sc = (lineIdx, basis, v) => ({ lineIdx, basis, v });
const lineAlloc = (m, value, lines) => ({ kind: 'milestone', refId: m.id, qty: null, value, lines });
const fails = (r, re) => !r.ok && re.test((r.errors || []).map(e => typeof e === 'string' ? e : e.msg).join(' ') + ' ' + JSON.stringify(r.errors || ''));
const evalErr = (po, allocs, extra = {}) => { const b = buildInvoice({ poId: po.id, supplierId: po.supplierId, number: 'E-' + (++bn), date: todayISO(), allocs, ...extra }); return allocErrors(b).map(e => e.msg).join(' | '); };

/* I01 one invoice, one milestone: fully covered unless partial billing is on */
{ const r = mk({ lines: [lineDef('Goods', 10, 1000)], ms: [{ name: 'M', pct: 100, needsGrn: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 10, null, { milestoneId: m.id });
  S('I01 a milestone without partial billing must be invoiced in full (6,000 refused, 10,000 accepted)', !subm(po, [ma(getMS(m.id), 6000)]).ok && subm(po, [ma(getMS(m.id), 10000)]).ok); }

/* I02 one invoice, several milestones: each allocation must pass; the due date follows the earliest */
{ const r = mk({ lines: [lineDef('Goods', 10, 1000)], settings: { dueBasis: 'acceptance', dueDays: 30 }, ms: [{ name: 'A', pct: 50 }, { name: 'B', pct: 50 }] }), po = r.po, [a, b] = msOf(po); approveToday(a); approveToday(b);
  getMS(a.id).approvedAt = new Date(Date.now() - 5 * 864e5).toISOString();
  const bad = subm(po, [ma(getMS(a.id)), ma(getMS(b.id), 4000)]);
  S('I02 one bad allocation blocks the whole invoice (B must be billed in full)', !bad.ok);
  const i = subm(po, [ma(getMS(a.id)), ma(getMS(b.id))]), inv = getInv(i.id);
  S('I02 two milestones on one invoice: due split per milestone, header due date = the earliest (A: +25d, B: +30d)', i.ok && inv.dueSplit.split.length === 2 && inv.dueSplit.earliest === daysFromNow(25) && inv.dueDate === daysFromNow(25), inv.dueSplit); }

/* I03 several invoices on one milestone only with partial billing, each within the remaining balance */
{ const r = mk({ lines: [lineDef('Goods', 10, 1000)], ms: [{ name: 'M', pct: 100, allowPartial: true, needsGrn: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 10, null, { milestoneId: m.id });
  const a = subm(po, [ma(getMS(m.id), 4000)]), b = subm(po, [ma(getMS(m.id), 7000)]), c = subm(po, [ma(getMS(m.id), 6000)]);
  S('I03 4,000 then 6,000 fit; 7,000 does not (remaining 6,000)', a.ok && !b.ok && c.ok && !subm(po, [ma(getMS(m.id), 1)]).ok); }

/* I04 one PO line across two milestones: separate lines, each within its own portion */
{ const r = mk({ lines: [lineDef('Servers', 10, 1000)], ms: [{ name: 'A', scope: [sc(0, 'quantity', 6)], allowPartial: true }, { name: 'B', scope: [sc(0, 'quantity', 4)], allowPartial: true }] }), po = r.po, [a, b] = msOf(po);
  approveToday(a); approveToday(b); grn(po, 0, 6, null, { milestoneId: a.id }); grn(po, 0, 4, null, { milestoneId: b.id });
  const bad = subm(po, [lineAlloc(getMS(a.id), 7000, [{ lineId: po.lines[0].id, value: 7000, qty: 7, rate: 1000 }])]);
  S('I04 the line is billed per milestone: 7 units against A\'s 6 are refused', !bad.ok);
  S('I04 …and 6 on A + 4 on B go through as two separate allocations', subm(po, [lineAlloc(getMS(a.id), 6000, [{ lineId: po.lines[0].id, value: 6000, qty: 6, rate: 1000 }]), lineAlloc(getMS(b.id), 4000, [{ lineId: po.lines[0].id, value: 4000, qty: 4, rate: 1000 }])]).ok); }

/* I05–I07 receipts: one line backed by several receipts, part of a receipt, FIFO by acceptance date, override before submit, locked after */
{ const r = mk({ poDate: daysFromNow(-10), lines: [lineDef('Servers', 100, 1000)], ms: [{ name: 'M', scope: [sc(0, 'quantity', 100)], allowPartial: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m);
  const g1 = grn(po, 0, 30, daysFromNow(-3), { milestoneId: m.id }), g2 = grn(po, 0, 40, daysFromNow(-1), { milestoneId: m.id });
  const i1 = subm(po, [ma(getMS(m.id), 50000)]), t1 = allocTrace(getInv(i1.id));
  S('I05 one invoice line backed by two receipts → one allocation row per receipt line (GRN-001 30 + GRN-002 20)', t1.length === 2 && t1[0].receipt === g1.number && t1[0].qty === 30 && t1[1].receipt === g2.number && t1[1].qty === 20, t1);
  S('I06 using part of a receipt leaves the rest eligible (GRN-002 has 20 of 40 left)', t1[1].partial === true && t1[1].left === 20000);
  const i2 = subm(po, [ma(getMS(m.id), 10000)]), t2 = allocTrace(getInv(i2.id));
  S('I07 FIFO by acceptance date: the next 10 units come from GRN-002, not a newer receipt', t2.length === 1 && t2[0].receipt === g2.number && t2[0].qty === 10, t2);
  S('I07 the receipt feeding is locked at submit (snapshot stored on the allocation)', (getInv(i1.id).allocs[0].trace || []).length === 2);
  const pre = allocTrace({ ...getInv(i1.id), allocs: [{ ...getInv(i1.id).allocs[0], recOrder: [g2.id] }] });
  S('I07 an override (before reservation) puts the chosen receipt first (GRN-002 40, then GRN-001 10)', pre[0].receipt === g2.number && pre[0].qty === 40 && pre[1].receipt === g1.number && pre[1].qty === 10, pre); }

/* I08 quantity and amount-only portions together */
{ const lines = [lineDef('Servers', 10, 1000), lineDef('Installation', 1, 50000, { kind: 'Services', uom: 'Lot' })];
  const r = mk({ type: 'Mixed', lines, ms: [{ name: 'M', scope: [sc(0, 'quantity', 10), sc(1, 'amount', 50000)], allowPartial: true, needsSrn: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 10, null, { milestoneId: m.id }); srn(po, 1, 50000, { milestoneId: m.id });
  const ok = subm(po, [lineAlloc(getMS(m.id), 60000, [{ lineId: po.lines[0].id, value: 10000, qty: 10, rate: 1000 }, { lineId: po.lines[1].id, value: 50000 }])]);
  S('I08 a quantity portion and an amount-only portion on one invoice; the amount-only line carries no quantity', ok.ok && getInv(ok.id).allocs[0].lines[1].qty === null, ok.errors); }

/* I09 quantity above accepted but within the PO */
{ const r = mk({ lines: [lineDef('Servers', 100, 1000)], ms: [{ name: 'M', scope: [sc(0, 'quantity', 100)], allowPartial: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 50, null, { milestoneId: m.id });
  const e = evalErr(po, [lineAlloc(getMS(m.id), 70000, [{ lineId: po.lines[0].id, value: 70000, qty: 70, rate: 1000 }])]);
  S('I09 70 units against 50 accepted is blocked and the accepted quantity is shown', /accepted, unbilled quantity of 50 Units/.test(e), e); }

/* I10 invoice before eligibility */
{ const r = mk({ lines: [lineDef('Goods', 10, 1000)], ms: [{ name: 'M', pct: 100 }] }), po = r.po, m = msOf(po)[0];
  S('I10 invoicing a milestone that is not approved is blocked', fails(subm(po, [ma(m)]), /not invoice-eligible|not approved|MS_NOT_APPROVED/i)); }

/* I11 rate differs from the PO */
{ const mkR = tol => mk({ lines: [lineDef('Servers', 10, 1000)], settings: tol ? { valueTolerancePct: tol } : undefined, ms: [{ name: 'M', scope: [sc(0, 'quantity', 10)], allowPartial: true }] });
  const r = mkR(0), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 10, null, { milestoneId: m.id });
  const L = rate => [lineAlloc(getMS(m.id), 10 * rate, [{ lineId: po.lines[0].id, value: 10 * rate, qty: 10, rate }])];
  S('I11 a rate of 1,100 against the PO rate 1,000 is blocked', /rate .*1,100.* differs from the PO rate/i.test(evalErr(po, L(1100))));
  const r2_ = mkR(10), p2 = r2_.po, m2 = msOf(p2)[0]; approveToday(m2); grn(p2, 0, 10, null, { milestoneId: m2.id });
  S('I11 …but within the PO\'s rate tolerance (10%) it passes the line check', !/differs from the PO rate/.test(evalErr(p2, [lineAlloc(getMS(m2.id), 10500, [{ lineId: p2.lines[0].id, value: 10500, qty: 10, rate: 1050 }])]))); }

/* I13 unit of measure */
{ const conv = { ...lineDef('Cable', 100, 100), uom: 'Metre', convs: { Box: 10 } }, noConv = { ...lineDef('Cable', 100, 100), uom: 'Metre' };
  const run = line => { const r = mk({ lines: [line], ms: [{ name: 'M', scope: [sc(0, 'quantity', 100)], allowPartial: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 100, null, { milestoneId: m.id });
    return evalErr(po, [lineAlloc(getMS(m.id), 5000, [{ lineId: po.lines[0].id, value: 5000, qty: 5, rate: 1000, uom: 'Box' }])]); };
  S('I13 5 Boxes at 1,000 convert with the PO line factor (1 Box = 10 Metre) → 50 Metre at 100: accepted', run(conv) === '', run(conv));
  S('I13 no conversion factor on the PO line → blocked', /no conversion factor/.test(run(noConv)), run(noConv)); }

/* I14 mixed tax rates */
{ const l2 = { ...lineDef('Cables', 10, 1000), gstRate: 12 };
  const r = mk({ lines: [lineDef('Servers', 10, 1000), l2], ms: [{ name: 'M', scope: [sc(0, 'quantity', 10), sc(1, 'quantity', 10)], allowPartial: true }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 10, null, { milestoneId: m.id }); grn(po, 1, 10, null, { milestoneId: m.id });
  const i = subm(po, [lineAlloc(getMS(m.id), 20000, [{ lineId: po.lines[0].id, value: 10000, qty: 10, rate: 1000 }, { lineId: po.lines[1].id, value: 10000, qty: 10, rate: 1000 }])]), inv = getInv(i.id);
  S('I14 each line is taxed at its own PO-line rate: 18% of 10,000 + 12% of 10,000 = 3,000 (header = sum of the lines)', i.ok && inv.taxMixed && inv.gst === 3000 && inv.gross === 23000, [inv.gst, inv.gross]);
  S('I14 an invoice line taxed at 18% against a 12% PO line is blocked', /taxed at 18% but the PO line carries 12%/.test(evalErr(po, [lineAlloc(getMS(m.id), 10000, [{ lineId: po.lines[1].id, value: 10000, qty: 10, rate: 1000, gstRate: 18 }])]))); }

/* I15 fixed price vs measured service value */
{ const mkS = measured => { const r = mk({ type: 'Services', lines: [lineDef('Fit-out', 1, 100000, { kind: 'Services', uom: 'Lot' })], ms: [{ name: 'Works', scope: [sc(0, 'amount', 100000)], needsSrn: true, allowPartial: true, measured }] }), po = r.po, m = msOf(po)[0]; approveToday(m); srn(po, 0, 60000, { milestoneId: m.id }); return { po, m }; };
  const f = mkS(false), me = mkS(true);
  S('I15 fixed: the SRN is evidence — the milestone amount (100,000) is billable although the SRN says 60,000', msEnt(getMS(f.m.id), f.po) === 100000 && subm(f.po, [ma(getMS(f.m.id), 100000)]).ok);
  S('I15 measured: billable only up to the accepted service value (60,000); 70,000 is blocked', msEnt(getMS(me.m.id), me.po) === 60000 && !subm(me.po, [ma(getMS(me.m.id), 70000)]).ok && subm(me.po, [ma(getMS(me.m.id), 60000)]).ok); }

/* I17 credit note vs reversal; I18 debit note needs an approved amendment */
{ const r = mk({ lines: [lineDef('Goods', 20, 1000)], ms: [{ name: 'M', pct: 50, allowPartial: true, needsGrn: true }, { name: 'N', pct: 50 }] }), po = r.po, m = msOf(po)[0]; approveToday(m); grn(po, 0, 10, null, { milestoneId: m.id });
  const i = subm(po, [ma(getMS(m.id), 6000)]), inv = getInv(i.id); A.approveInvoice(i.id); A.postInvoice(i.id);
  const before = payable(inv), cn = A.addAdjustment(i.id, { type: 'Credit', amount: 1000, reason: 'short delivery' });
  S('I17 a credit note reduces the payable but does not restore milestone eligibility', cn.ok && payable(getInv(i.id)) === before - 1000 && usage('milestone', m.id).value === 6000);
  const d0 = A.addAdjustment(i.id, { type: 'Debit', amount: 1180, reason: 'variation' });
  S('I18 a debit note for a variation needs an approved PO amendment reference', !d0.ok && /needs an approved PO amendment/.test(d0.msg), d0.msg);
  const am = A.amendMilestone(po.id, msOf(po)[1].id, { planned: daysFromNow(40) }, 'variation approved'); const v = getPO(po.id).version;
  const d1 = A.addAdjustment(i.id, { type: 'Debit', amount: 1180, reason: 'variation', variationRef: v });
  S('I18 with the amendment and room left on the milestone (4,000 unbilled) the debit note is recorded', am.ok && d1.ok, [am.msg, d1.msg]);
  const d2 = A.addAdjustment(i.id, { type: 'Debit', amount: 59000, reason: 'variation', variationRef: v });
  S('I18 …but never above the milestone amount (59,000 incl. GST would exceed the 4,000 still unbilled)', !d2.ok && /above its amount/.test(d2.msg), d2.msg);
  const rv = A.reverseInvoice(i.id, 'goods returned'); S('I17 only an explicit reversal restores the eligibility', rv.ok && usage('milestone', m.id).value === 0); }

console.log(dfails ? `\nLINK ${dfails} FAILED of ${dcount}` : `\nLINK ALL PASSED (${dcount} checks)`);
if (dfails) throw new Error('link tests failed');