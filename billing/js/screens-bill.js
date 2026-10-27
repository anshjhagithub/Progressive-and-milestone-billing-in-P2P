/* =====================================================================
   screens-bill.js — the PO "Billing" tab: milestones, certified progress claims,
   receipt-based allocation, and their drawers
   ===================================================================== */
const allocRefLabel = a => a.kind === 'grn' ? getGRN(a.refId)?.number : a.kind === 'srn' ? getSRN(a.refId)?.number : a.kind === 'milestone' ? getMS(a.refId) && msFull(getMS(a.refId)) : a.kind === 'advance' ? getAdv(a.refId)?.number : getClaim(a.refId)?.number;
/* acceptance conditions of a milestone as small status lines (document approval, guarantee, accepted GRN / SRN, accepted quantity, complete quantity) */
const condTitle = c => c.key === 'trigger' ? 'Quantity trigger' : c.key === 'qty' ? 'Accepted quantity' : c.key === 'complete' ? 'Complete quantity' : c.key === 'doc' || c.key === 'guarantee' ? c.title : `Accepted ${c.key.toUpperCase()}`;
const condShort = c => c.key === 'trigger' ? 'quantity trigger' : c.key === 'doc' ? 'document' : c.key === 'guarantee' ? 'guarantee' : c.key === 'complete' ? 'full quantity' : c.key === 'qty' ? 'quantity' : c.key.toUpperCase();
const gateCell = (m, po) => { const g = msGate(m, po); return !g.required ? '<span class="dim-note">None required</span>' : g.conds.map(c => c.key === 'doc' || c.key === 'guarantee'
  ? `<div class="cc">${sb(c.status)} <span class="cc-t">${esc(c.title)}</span></div>`
  : c.key === 'trigger' ? `<div class="cc">${sb(c.ok ? 'Accepted' : c.status)} <span class="cc-t">${c.ok ? `Fired · ${fq(c.cum)} cumulative` : `${fq(c.cum)} of ${fq(c.need)} reached`}</span></div>`
  : c.key === 'qty' ? `<div class="cc">${sb(c.status)} <span class="cc-t">Quantity</span></div>`
  : c.key === 'complete' ? `<div class="cc">${sb(c.ok ? 'Accepted' : 'Incomplete')} <span class="cc-t">Complete quantity</span></div>`
  : `<div class="cc">${c.recs.length ? `<b>${esc(c.recs.map(r => r.number).join(', '))}</b> ${sb(c.status)}` : `<span class="warn-t">${c.key.toUpperCase()} · none linked</span>`}</div>`).join(''); };

/* ================================================================ receipt-based allocation (Standard / Progressive) */
function receiptEntitlementTable(po, s, progressive) {
  const items = s.items, alloc = [], g = isGoods(po);
  invsOf(po).filter(isLive).forEach(i => i.allocs.forEach(a => alloc.push({ i, a })));
  return `<div class="sec" style="margin-top:22px">${progressive ? `${recName(po)} allocation` : `Accepted ${recName(po)}s`}<span class="sub">${progressive ? `${recName(po)} value consumed by invoices (live = in approval, approved, posted or paid)` : 'Standard billing matches invoices against the accepted total at PO level'}</span><span class="spacer"></span>${po.status === 'Approved' ? gbtn('inv.create', 'inv-new', 'Submit Invoice', { cls: 'btn-primary', data: { po: po.id }, icn: 'plus' }) : ''}</div>
  <div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>${recName(po)}</th>${g ? '<th class="right">Delivered</th><th class="right">Accepted</th>' : ''}<th class="right">Accepted value</th><th class="right">Invoiced · approved</th><th class="right">Invoiced · in approval</th>${g ? '<th class="right">Available qty</th>' : ''}<th class="right">Available value</th><th>Status</th></tr></thead><tbody>
  ${items.map(x => `<tr class="${x.eligible ? '' : 'dim'}"><td class="strong"><a class="link" data-act="rc-open" data-kind="${x.kind}" data-id="${x.refId}" href="javascript:void 0">${x.label}</a><div class="sub">${fmtD(x.ref.date)}</div></td>${g ? `<td class="num">${fmtNum(x.ref.received)}</td><td class="num">${fmtNum(x.entQty)}</td>` : ''}<td class="num">${fmtNum(x.entValue)}</td>
    <td class="num">${g ? `${fmtNum(x.committedQty)} u / ` : ''}${fmtNum(x.committedValue)}</td><td class="num">${g ? `${fmtNum(x.reservedQty)} u / ` : ''}${fmtNum(x.reservedValue)}</td>${g ? `<td class="num">${fmtNum(x.availQty)}</td>` : ''}<td class="num strong">${fmtNum(x.availValue)}</td><td>${sb(x.status)}${!x.eligible && x.reason ? `<div class="sub">${esc(x.reason)}</div>` : ''}</td></tr>`).join('') || emptyRow(g ? 9 : 7, `No ${recName(po)}s yet — receipts are created from the ${recName(po)} tab.`)}
  <tr class="total"><td>Total</td>${g ? `<td class="num">${fmtNum(sum(items, x => x.ref.received))}</td><td class="num">${fmtNum(sum(items, x => x.entQty || 0))}</td>` : ''}<td class="num">${fmtNum(s.accepted)}</td><td class="num">${fmtNum(sum(items, x => x.committedValue))}</td><td class="num">${fmtNum(sum(items, x => x.reservedValue))}</td>${g ? `<td class="num">${fmtNum(sum(items, x => x.availQty || 0))}</td>` : ''}<td class="num">${fmtNum(s.remaining)}</td><td></td></tr></tbody></table></div>
  ${progressive ? `<div class="sec">Allocations by invoice</div><div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Invoice</th><th>Bill No.</th><th>${recName(po)}</th>${g ? '<th class="right">Qty</th>' : ''}<th class="right">Value</th><th>Invoice status</th><th>Allocation</th></tr></thead><tbody>${alloc.map(({ i, a }) => `<tr><td>${invLink(i)}</td><td>${esc(i.number)}</td><td>${esc(allocRefLabel(a))}</td>${g ? `<td class="num">${a.qty != null ? fmtNum(a.qty) : '—'}</td>` : ''}<td class="num">${fmtNum(a.value)}</td><td>${sb(i.status)}</td><td>${sb(APPROVED.includes(i.status) ? 'Committed' : 'Reserved')}</td></tr>`).join('') || emptyRow(g ? 7 : 6, 'No invoice has used a receipt yet.')}</tbody></table></div>` : ''}`;
}

/* ---- timing & dependencies (view) ---- */
const depChipLive = (m, d, po) => { const pred = msOf(po).find(x => x.code === d.pred), r = depReached(d, pred, po), gate = d.effect !== 'schedule';
  return `<span class="dep-chip ${gate ? 'gate' : 'schedule'} ${r.ok ? 'met' : 'wait'}" title="${esc(DEP_TYPES[d.type])}${d.lag ? ', ' + (d.lag > 0 ? '+' : '') + d.lag + ' days' : ''} · ${esc(DEP_EFFECTS[d.effect])} · ${r.ok ? 'met' : pred ? 'waiting' : 'predecessor missing'}">${esc(d.pred)} ${d.type}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}${gate ? ' ' + icon('lock', 10, 2.4) : ''}</span>`; };
function msTimelineCell(m, po, dates) {
  const d = dates[m.code] || {}, late = d.slip > 0, done = d.source === 'actual' && m.status === 'Approved';
  const l1 = done ? `Done ${fmtD(d.finish)}` : d.finish ? `${late ? 'Forecast' : 'Due'} ${fmtD(d.finish)}` : '<span class="dim-note">no date</span>';
  const chip = d.slip ? `<span class="tl-chip ${d.slip > 0 ? 'late' : 'early'}">${d.slip > 0 ? '+' : ''}${d.slip}d</span>` : '';
  const deps = depList(m).map(x => depChipLive(m, x, po)).join('');
  const dmg = m.damages && msDelay(m).days ? `<div class="sub" style="color:#B42318">${msDelay(m).days}d late · damages apply</div>` : '';
  return `<div class="tl">${l1} ${chip}</div>${dmg}${d.plannedFinish && (late || done) && d.plannedFinish !== d.finish ? `<div class="sub">planned ${fmtD(d.plannedFinish)}</div>` : ''}${+m.durationDays ? `<div class="sub">${m.durationDays} day${m.durationDays > 1 ? 's' : ''}${d.start ? ` · from ${fmtD(d.start)}` : ''}</div>` : ''}${deps ? `<div class="dep-chips">${deps}</div>` : ''}${m.closing ? '<div class="dep-chips"><span class="dep-chip closing">Closes the PO</span></div>' : ''}`;
}
/* a light timeline: one bar per milestone from start to (forecast) finish, today marked */
function ganttHtml(po, dates) {
  const ms = msOf(po).filter(m => (dates[m.code] || {}).finish); if (ms.length < 2 && !ms.some(m => +m.durationDays || depList(m).length)) return '';
  const rows = ms.map(m => { const d = dates[m.code]; return { m, s: d.start || d.finish, e: d.finish, ps: d.plannedStart || d.plannedFinish, pe: d.plannedFinish }; });
  const all = rows.flatMap(r => [r.s, r.e, r.ps, r.pe]).filter(Boolean).concat(todayISO()).sort(), lo = all[0], hi = all[all.length - 1], span = Math.max(1, dpDiff(lo, hi)), pc = x => (dpDiff(lo, x) / span * 100).toFixed(2);
  const col = m => m.status === 'Approved' ? 'var(--success)' : ['Submitted for Approval', 'Under Review'].includes(m.status) ? '#E8A33D' : m.status === 'In Progress' ? 'var(--primary)' : '#B8B6C9';
  return `<details class="mm-sec ctl" open><summary><b>Timeline</b><span class="hint">${fmtD(lo)} → ${fmtD(hi)} · bars show the forecast; the thin line is the plan</span></summary><div class="mm-body"><div class="gantt">${rows.map(r => `<div class="g-row"><div class="g-l"><b>${r.m.code}</b> ${esc(r.m.name)}</div><div class="g-t"><i class="g-now" style="left:${pc(todayISO())}%"></i>${dpDiff(r.ps, r.pe) > 0 || dpDiff(r.s, r.e) > 0 ? `<div class="g-plan" style="left:${pc(r.ps)}%;width:${Math.max(0.6, dpDiff(r.ps, r.pe) / span * 100).toFixed(2)}%"></div>` : ''}${dpDiff(r.s, r.e) > 0 ? `<div class="g-bar" style="left:${pc(r.s)}%;width:${(dpDiff(r.s, r.e) / span * 100).toFixed(2)}%;background:${col(r.m)}" title="${fmtD(r.s)} → ${fmtD(r.e)}"></div>` : `<div class="g-dia" style="left:${pc(r.e)}%;background:${col(r.m)}" title="${fmtD(r.e)}"></div>`}${r.pe && r.pe !== r.e ? `<div class="g-dia plan" style="left:${pc(r.pe)}%" title="planned ${fmtD(r.pe)}"></div>` : ''}</div></div>`).join('')}</div></div></details>`;
}
/* drawer: dates, predecessors with their live state, successors */
function msTimingBlock(m, po) {
  const dates = msDates(po), d = dates[m.code] || {}, deps = depList(m), gate = depGate(m, po, 'bill'), gateS = depGate(m, po, 'start'), gateA = depGate(m, po, 'approve'), succ = msOf(po).filter(x => x.id !== m.id && depCodes(x).includes(m.code));
  const row = x => { const pred = msOf(po).find(q => q.code === x.pred), r = depReached(x, pred, po), what = x.type === 'SS' ? 'started' : x.state, isG = x.effect !== 'schedule';
    return `<tr><td><b>${esc(x.pred)}</b>${pred ? `<div class="sub">${esc(pred.name)}</div>` : '<div class="sub" style="color:var(--danger)">no longer exists</div>'}</td><td>${esc(DEP_TYPES[x.type])}</td><td class="num">${x.lag ? (x.lag > 0 ? '+' : '') + x.lag + ' d' : '—'}</td><td>${esc(DEP_EFFECTS[x.effect])}</td><td>${esc(what)}</td><td>${sb(r.ok ? 'Met' : 'Waiting')}${!r.ok && pred ? `<div class="sub">${esc(pred.status)}</div>` : ''}</td><td class="sub">${isG ? (x.type === 'FS' ? 'billing' : x.type === 'SS' ? 'start' : 'approval') : 'dates only'}</td></tr>`; };
  const held = [...gate.unmet, ...gateS.unmet, ...gateA.unmet];
  const kvs = `<div class="kvg c4">${kv('Planned', d.plannedFinish ? `${d.plannedStart && d.plannedStart !== d.plannedFinish ? fmtD(d.plannedStart) + ' → ' : ''}${fmtD(d.plannedFinish)}` : '—')}${kv(d.source === 'actual' && m.status === 'Approved' ? 'Actual' : 'Forecast', d.finish ? `${fmtD(d.finish)}${d.slip ? ` <span class="tl-chip ${d.slip > 0 ? 'late' : 'early'}">${d.slip > 0 ? '+' : ''}${d.slip}d</span>` : ''}` : '—')}${kv('Duration', +m.durationDays ? m.durationDays + ' days' : '—')}${kv('Basis', d.source ? ({ actual: 'Actual date', 'actual start': 'Started, finish forecast', forecast: 'Forecast', planned: 'Planned', derived: 'Derived from predecessors' }[d.source] || d.source) : '—')}</div>`;
  const dl = msDelay(m), dgp = m.damages ? damagesFor(m, 100) : null;
  const dmgLine = m.damages ? `<div class="hint" style="margin-top:10px"><b>Delay damages</b> · ${m.damages.ratePct}% of the milestone value per week or part late, capped at ${m.damages.capPct}%${dl.days ? ` — finished ${dl.days} day(s) late (${dl.weeks} week${dl.weeks > 1 ? 's' : ''} or part) → <span class="warn-t"><b>${dgp ? dgp.pct : 0}%</b> = ${money(r2(m.amount * (dgp ? dgp.pct : 0) / 100))} deducted from the payable</span>` : ' — none so far.'}${m.originalPlanned ? ` · due date extended from ${fmtD(m.originalPlanned)}` : ''}</div>` : '';
  const edit = po.status === 'Approved' && usage('milestone', m.id).value <= EPS ? gbtn('po.amend', 'ms-timing', 'Edit timing & dependencies', { cls: 'btn-outline btn-sm', data: { id: m.id }, icn: 'edit' }) : (usage('milestone', m.id).value > EPS ? `<span class="hint">${icon('lock', 12)} Invoiced — dates and dependencies are frozen.</span>` : '');
  return `<div class="sec-h">Timing & dependencies <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0">· a late date never blocks billing — only a gate does</span></div><div class="card flat">${kvs}
    ${deps.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl sm"><thead><tr><th>Waits for</th><th>Relation</th><th class="right">Lag</th><th>Effect</th><th>When</th><th>State</th><th>Acts on</th></tr></thead><tbody>${deps.map(row).join('')}</tbody></table></div>${deps.filter(x => x.effect !== 'schedule').length > 1 ? `<div class="hint" style="margin-top:6px">Gate rule: ${depJoin(m) === 'ANY' ? 'any one of the gates is enough' : 'all gates must be met'}.</div>` : ''}` : '<div class="hint" style="margin-top:10px">Does not wait for any other milestone.</div>'}
    ${dmgLine}
    ${held.length ? `<div style="margin-top:10px">${alertBox('warn', 'Held by a dependency', held.map(h => esc(h.why)).join('<br>'))}</div>` : ''}
    ${succ.length ? `<div class="hint" style="margin-top:10px">Waited on by ${succ.map(x => `<b>${x.code}</b>`).join(', ')}.</div>` : ''}
    ${m.closing ? `<div class="hint" style="margin-top:8px">${icon('lock', 12)} <b>Closing milestone</b> — approved only after every other milestone and receipt is complete.${closingBlock(m, po) ? ` <span class="warn-t">${esc(closingBlock(m, po))}</span>` : ''}</div>` : ''}
    <div class="row" style="margin-top:12px">${edit}</div></div>`;
}

/* ================================================================ milestones */
/* Lifecycle: Pending → In Progress → Submitted for Approval → Under Review → Approved (or Rejected → resubmit).
   Billable once Approved AND every configured acceptance condition holds (document approval / accepted GRN / accepted SRN).
   Milestone-first: from a milestone you can create / link its GRN or SRN and then invoice it, all from one drawer. */
function milestoneTable(po, s) {
  const ms = msOf(po), dates = msDates(po), tot = sum(ms, m => m.amount), appr = sum(ms, m => msEnt(m, po)), inv = sum(ms, m => usage('milestone', m.id).value);
  return `<div class="sec" style="margin-top:22px">Milestone schedule<span class="sub">Open a milestone to submit evidence, approve it, create or link its receipts, and invoice it</span><span class="spacer"></span>${po.status === 'Draft' ? gbtn('po.edit', 'po-edit', 'Edit schedule', { data: { id: po.id }, icn: 'edit', cls: 'btn-primary' }) : ''}${po.status === 'Approved' ? gbtn('po.amend', 'ms-amend-add', 'Add milestone', { data: { po: po.id }, icn: 'plus' }) : ''}${po.status === 'Approved' ? gbtn('po.amend', 'po-amend', 'Amend schedule', { data: { id: po.id }, icn: 'edit' }) : ''}</div>
  ${strip([['Schedule total', money(tot), `${fmtNum(sum(ms, m => m.pct))}% of PO`], ['Approved & cleared', money(appr), 'invoice-eligible'], ['Invoiced / reserved', money(inv)], ['Ready to invoice', money(s.remaining), 'approved − invoiced', 'hl']])}
  ${ganttHtml(po, dates)}
  <div class="tbl-wrap" style="margin-top:14px"><table class="tbl ms-tbl"><thead><tr><th style="width:44px">ID</th><th>Milestone</th><th style="width:170px">Timeline</th><th class="right" style="width:110px">Amount</th><th style="width:130px">Status</th><th>Acceptance</th><th class="right" style="width:96px">Invoiced</th><th style="width:150px"></th></tr></thead><tbody>
  ${ms.map(m => { const u = usage('milestone', m.id), bill = msBilling(m, po);
    return `<tr class="click" data-act="ms-open" data-id="${m.id}"><td class="strong">${m.code}</td><td class="strong">${esc(m.name)}<div class="sub" style="font-weight:400">${esc(scopeSummary(m, po.lines))}${m.allowPartial ? ' · partial invoicing' : ''}${m.advance && m.advance.allowed ? ' · advance' : ''}</div></td><td>${msTimelineCell(m, po, dates)}</td><td class="num"><b>${fmtNum(m.amount)}</b><div class="sub">${fmtNum(m.pct)}%</div></td><td>${sb(m.status)}<div style="margin-top:4px">${sb(bill)}</div></td><td>${gateCell(m, po)}</td><td class="num">${u.value ? fmtNum(u.value) : '—'}${u.invs.length ? `<div class="sub">${u.invs.map(invRef).join(', ')}</div>` : ''}</td><td class="act" data-stop>${msRowAction(m, po)}<button class="btn-view" data-act="ms-open" data-id="${m.id}">${icon('open', 12, 2)}View</button></td></tr>`; }).join('') || emptyRow(8, 'No milestones.')}
  <tr class="total"><td colspan="3">Total</td><td class="num">${fmtNum(tot)}<div class="sub">${fmtNum(sum(ms, m => m.pct))}%</div></td><td colspan="2"></td><td class="num">${fmtNum(inv)}</td><td></td></tr></tbody></table></div>
  <p class="hint" style="margin-top:10px">${icon('lock', 12)} Once a milestone is submitted, approved or invoiced it is locked; changes need a PO amendment, and invoiced amounts are never rewritten. A passed due date never makes a milestone billable.</p>`;
}
const roleBtn = (perm, label) => actBtn('role-switch', label, { cls: 'btn-primary btn-xs', data: { role: rolesFor(perm)[0] } });
/* the one next action for a milestone, shown right on its schedule row */
function msRowAction(m, po) {
  const g = msGate(m, po), ent = msEnt(m, po), u = usage('milestone', m.id), x = { cls: 'btn-primary btn-xs', data: { id: m.id } };
  if (m.status === 'Pending') return (can('ms.start') ? gbtn('ms.start', 'ms-start', 'Start', x) : roleBtn('ms.start', 'Switch role to start')) + ' ';
  if (['In Progress', 'Rejected'].includes(m.status)) return actBtn('ms-open', m.status === 'Rejected' ? 'Resubmit' : 'Submit', { ...x, icn: 'upload' }) + ' ';
  if (msAwaiting(m)) return (can('ms.decide') ? gbtn('ms.decide', 'ms-approve', 'Approve', x) : roleBtn('ms.decide', 'Switch role to approve')) + ' ';
  if (m.status === 'Approved') {
    if (ent - u.value > EPS && sourceItems(po).find(q => q.refId === m.id && q.eligible)) return gbtn('inv.create', 'inv-new', 'Invoice', { cls: 'btn-primary btn-xs', data: { po: po.id, ms: m.id } }) + ' ';
    if (!g.ok) return actBtn('ms-open', `Needs ${g.conds.filter(c => !c.soft && !c.ok).map(condShort).join(' + ')}`, { cls: 'btn-outline btn-xs', data: { id: m.id }, title: g.reason }) + ' ';
  }
  return '';
}
ACT['ms-open'] = el => openMilestonePanel(el.dataset.id);
function openMilestonePanel(id) {
  const get = () => getMS(id), m0 = get();
  openPanel({ key: 'ms-' + id, mid: true, title: () => `${get().code} — ${get().name}`, sub: () => 'All milestone details',
    init: () => ({ actualDate: m0.actualDate || todayISO(), remarks: '', evFiles: [] }),
    body: () => msPanelBody(get()), foot: () => msPanelFoot(get()) });
}
/* linked GRNs / SRNs of one kind, with create / link / unlink — "milestone first, then receipt" */
function msReceiptCard(m, po, kind, u) {
  const c = recCond(m, kind), N = kind.toUpperCase(), g = kind === 'grn', perm = g ? 'grn.create' : 'srn.create', locked = u.value > EPS && hardReceiptGate(m, po);
  const lines = (m.scope || []).map(x => lineOf(po, x.lineId)).filter(l => l && lineKind(po, l) === (g ? 'Goods' : 'Services'));
  const line = r => { const sh = recShare(m, r, kind), lk = linksOf(r).find(x => x.msId === m.id), ln = lineOf(po, r.lineId);
    return `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(r.number)}</b> ${sb(r.reversed ? 'Reversed' : g ? grnStatus(r) : r.status)}<span class="hint">${esc(ln ? ln.desc : '')} · ${g ? `${fmtNum(r.received)} delivered · ${fmtNum(r.accepted)} accepted` : `${money(r.serviceValue)} service value`}${lk && lk.cap != null ? ` · ${fq(lk.cap)} allocated here` : ''}${linksOf(r).length > 1 ? ` · shared with ${linksOf(r).filter(x => x.msId !== m.id).map(x => (getMS(x.msId) || {}).code).join(', ')}` : ''}${sh ? ` · counts ${g ? fq(sh) + ' units' : money(sh)}` : ''}</span><span class="spacer"></span><button class="link" data-act="rc-open" data-kind="${kind}" data-id="${r.id}">Open</button>${locked ? '' : `<button class="link" style="color:var(--danger)" data-act="ms-unlink" data-id="${m.id}" data-rec="${r.id}">Unlink</button>`}</div>`; };
  const recs = (kind === 'grn' ? (m.grnIds || []).map(getGRN) : (m.srnIds || []).map(getSRN)).filter(Boolean);
  const qty = (m.scope || []).some(x => x.basis === 'quantity' && lines.some(l => l.id === x.lineId));
  return `<div class="sec-h">${g ? 'Goods receipt (GRN)' : 'Service receipt (SRN)'} <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0">· records the real ${g ? 'goods and quantities' : 'service value'} received${m.needsDoc ? ' — separate from the document evidence' : ''}${lines.length ? ` · lines in scope: ${esc(lines.map(l => 'L' + l.no).join(', '))}` : ''}</span></div>
  <div class="card flat">${recs.map(line).join('') || `<div class="hint">No ${N} linked yet. Create one for this milestone, or link an existing one.</div>`}
    <div class="hint ${c.ok || (qty && !hardReceiptGate(m, po)) ? 'ok-t' : ''}" style="margin-top:8px">${qty && !hardReceiptGate(m, po) ? `Quantity portions count only accepted units — ${esc(msGate(m, po).conds.find(x => x.key === 'qty')?.reason || '')}.` : c.ok ? `${N} condition met — every linked ${N} is accepted.` : `Blocked: ${esc(c.reason)}.`}</div>
    ${locked ? '' : `<div class="row" style="margin-top:12px">${gbtn(perm, g ? 'grn-new' : 'srn-new', `Create ${N} for ${m.code}`, { data: { po: po.id, ms: m.id }, icn: 'plus', cls: 'btn-outline btn-sm' })}${actBtn('ms-link', `Link existing ${N}`, { data: { id: m.id, kind }, icn: 'link', cls: 'btn-outline btn-sm' })}</div>`}
    ${can(perm) ? '' : roleBanner(perm, `Creating the ${N}`)}</div>`;
}
function msScopeTable(m, po, g) {
  const sl = sliceRemaining(m, po); if (!sl.length) return '';
  const hardOk = m.status === 'Approved' && g.ok;
  const row = x => { const acc = x.basis === 'quantity' ? x.ent : hardOk ? x.value : 0, rem = r2(Math.max(0, acc - x.used)), sc = x.basis === 'quantity' ? `${fq(x.s.qty)} ${esc(x.line.uom)}` : x.basis === 'percent' ? `${fq(x.s.percent)}%` : 'lump sum';
    return `<tr><td>L${x.line.no} ${esc(x.line.desc)}<div class="sub">${x.kind === 'Goods' ? 'Goods' : 'Service'}</div></td><td>${BASIS_LABEL[x.basis]}</td><td class="num">${sc}</td><td class="num">${fmtNum(x.value)}</td><td class="num">${fmtNum(acc)}</td><td class="num">${x.used ? fmtNum(x.used) : '—'}</td><td class="num strong">${fmtNum(rem)}</td></tr>`; };
  return `<div class="sec-h">Scope <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0">· ${m.simple ? 'a % of every scheduled line' : 'line-scoped'} · the amount is derived from these portions</span></div>
  <div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Line</th><th>Basis</th><th class="right">Scope</th><th class="right">Portion value</th><th class="right">Eligible</th><th class="right">Billed</th><th class="right">Remaining</th></tr></thead><tbody>${sl.map(row).join('')}<tr class="total"><td colspan="3">Milestone amount</td><td class="num">${fmtNum(m.amount)}</td><td class="num">${fmtNum(msEnt(m, po))}</td><td class="num">${fmtNum(usage('milestone', m.id).value)}</td><td class="num">${fmtNum(Math.max(0, r2(msEnt(m, po) - usage('milestone', m.id).value)))}</td></tr></tbody></table></div>`;
}
function msAdvanceBlock(m, po) {
  if (!m.advance || !m.advance.allowed) return '';
  const t = m.advance, list = advOfMs(m), canReq = po.status === 'Approved' && !list.some(ADV_OPEN) && usage('milestone', m.id).value < m.amount - EPS, cf = poCfg(po);
  return `<div class="sec-h">Advance <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0">· part of this milestone paid early and recovered from its invoices</span></div>
  <div class="card flat"><div class="kvg c2">${kv('Terms', `${t.mode === 'percent' ? fmtNum(t.value) + '% of the milestone' : 'Fixed'} = ${money(advTermAmount(m))}`)}${kv('Recovery', t.recovery === 'first' ? 'From the first invoice' : 'Proportional to each invoice; the last recovers the rest')}${kv('Guarantee', t.guaranteeRequired ? esc(t.guaranteeTitle) : 'Not required')}${kv('Caps', `${cf.maxAdvancePctPerMilestone}% per milestone · ${cf.maxAdvancePctOfPO}% of the PO`)}</div>
    ${list.map(a => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line);margin-top:8px"><b>${esc(a.number)}</b> ${sb(advStatus(a))}<span class="hint">${money(a.base)}${advP(a) ? ` · outstanding ${money(advO(a))}` : ''}</span><span class="spacer"></span><button class="link" data-act="adv-open" data-id="${a.id}">Open</button></div>`).join('')}
    ${canReq ? `<div class="row" style="margin-top:12px">${gbtn('adv.request', 'adv-new', 'Request advance', { data: { po: po.id, ms: m.id }, icn: 'plus', cls: 'btn-outline btn-sm' })}</div>${can('adv.request') ? '' : roleBanner('adv.request', 'Requesting an advance')}` : ''}</div>`;
}
function msPanelBody(m) {
  const po = getPO(m.poId), u = usage('milestone', m.id), g = msGate(m, po), bill = msBilling(m, po), ent = msEnt(m, po), f = ui.f || {}, dt = docTitleOf(m), d = m.doc;
  const avail = Math.max(0, r2(ent - u.value)), gst = r2(m.amount * gstOf(po) / 100);
  const canSubmit = ['Pending', 'In Progress', 'Rejected'].includes(m.status) && po.status === 'Approved';
  const waitQty = m.status === 'Approved' && g.ok && !m.allowPartial && ent < m.amount - EPS && u.value <= EPS;
  const banner = {
    Draft: ['gray', 'Draft schedule', 'The PO is not approved yet — milestones start once the PO is approved.'],
    Pending: ['gray', 'Pending', 'Work has not started. Start it, or submit evidence directly when the work is done.'],
    'In Progress': ['blue', 'In progress', `Upload the evidence${m.needsDoc ? ` (the ${dt} is mandatory)` : ''} and submit for approval.`],
    'Submitted for Approval': ['blue', 'Submitted for approval', `Submitted by ${m.submittedBy || '—'} on ${fmtDT(m.submittedAt)}. An approver can start the review or decide right away.`],
    'Under Review': ['amber', 'Under review', `Review started by ${m.reviewedBy || '—'} on ${fmtDT(m.reviewedAt)}. Approve or reject it.`],
    Rejected: m.infoRequested ? ['amber', 'Information requested — resubmit', `${m.rejectReason || ''} Add the information and resubmit; both submissions are kept in the history.`] : ['red', 'Rejected — resubmit', `${m.rejectReason || ''} Upload corrected evidence and resubmit.`],
    Approved: !g.ok ? ['amber', 'Approved — invoicing blocked', `Invoicing stays blocked until: ${g.reason}.`]
      : waitQty ? ['amber', 'Approved — waiting for the remaining quantity', `${money(ent)} of ${money(m.amount)} is accepted. Without partial invoicing this milestone is billed once, in full, after the rest is accepted.`]
      : avail > EPS ? ['green', bill === 'Partially Invoiced' ? 'Approved — balance ready to invoice' : 'Approved — ready to invoice', `${money(avail)} can be invoiced now${m.allowPartial ? ' (in one or several parts)' : ''}. No quantity is created for document evidence.`]
      : u.value >= m.amount - EPS ? ['green', 'Approved and fully invoiced', 'The full milestone amount is on invoices; another invoice is blocked.']
      : ['blue', 'Approved — everything accepted so far is invoiced', `${money(u.value)} of ${money(m.amount)} is billed. The next shipment / acceptance makes the remaining ${money(r2(m.amount - ent))} billable.`],
  }[m.status] || ['gray', m.status, ''];
  const accCell = g.required ? g.conds.filter(c => !c.soft).map(condTitle).join(' + ') || 'Accepted quantity' : 'None';
  const check = [[m.status === 'Approved', 'Milestone approved', m.approvedAt ? `Approved ${fmtDT(m.approvedAt)}${m.approvedBy ? ' by ' + esc(m.approvedBy) : ''}` : `Status: ${m.status}`]];
  g.conds.forEach(c => check.push([c.ok, c.key === 'trigger' ? `Quantity trigger — ${fq(m.trigger.qty)} ${esc(c.line.uom)} of L${c.line.no} cumulative` : c.key === 'doc' ? `${esc(dt)} approved` : c.key === 'guarantee' ? `${esc(c.title)} verified` : c.key === 'qty' ? 'Accepted quantity' : c.key === 'complete' ? 'Complete quantity accepted' : `Accepted ${c.key.toUpperCase()} linked`,
    c.ok ? (c.key === 'trigger' ? `Fired by ${c.firedBy ? esc(c.firedBy.number) : 'a receipt'} — cumulative accepted ${fq(c.cum)}${c.surplus > 0 ? `; ${fq(c.surplus)} surplus unit(s) count toward ${triggerNext(m, po) ? triggerNext(m, po).code : 'the next portion'}` : ''}` : c.key === 'doc' ? `Approved ${fmtDT(d.decidedAt)} by ${esc(d.decidedBy)}` : c.key === 'guarantee' ? `Verified ${fmtDT(m.guarantee.verifiedAt)} by ${esc(m.guarantee.verifiedBy)} · valid until ${fmtD(m.guarantee.validUntil)}` : c.key === 'qty' ? esc(c.reason) : c.key === 'complete' ? 'All scoped quantity is accepted' : `${c.recs.filter(r => !r.reversed).map(r => r.number).join(', ')} accepted`) : esc(c.reason)]));
  if (!g.required) check.push([true, 'No extra acceptance required', 'Billable as soon as it is approved.']);
  { const gb = depGate(m, po, 'bill'); if (gb.rows.length) check.push([gb.ok, `Dependency gate${gb.rows.length > 1 ? ` (${gb.join === 'ANY' ? 'any one' : 'all'} of ${gb.rows.map(r => r.code).join(', ')})` : ` on ${gb.rows[0].code}`}`, gb.ok ? 'Cleared' : esc(gb.unmet.map(x => x.why).join('; '))]);
    else if (depList(m).length) check.push([true, `After ${depCodes(m).join(', ')}`, 'Schedule dependency only — it moves the forecast, it never blocks billing']); }
  check.push([u.value < m.amount - EPS, m.allowPartial ? 'Remaining to invoice' : 'Not yet invoiced', u.value >= m.amount - EPS ? `Invoiced on ${u.invs.map(invRef).join(', ')}` : `${money(r2(m.amount - u.value))} still to invoice`]);
  const need = canSubmit ? roleBanner(m.status === 'Pending' ? 'ms.start' : 'ms.submit', m.status === 'Pending' ? 'Starting or submitting a milestone' : 'Submitting evidence') : msAwaiting(m) ? roleBanner('ms.decide', 'Reviewing or approving this milestone') : '';
  const head = `<div class="rc-top"><div><div class="rc-line"><b>PO Number:</b> ${esc(po.number)}</div><div class="rc-line"><b>Milestone ID:</b> ${esc(m.code)}</div></div><div class="rc-btns">${sb(m.status)} ${sb(bill)}</div></div>
  <div class="rc-items"><b>All Details</b></div>
  <div class="tbl-wrap boxedtbl"><table class="tbl sm plain"><thead><tr><th>Milestone</th><th>Due Date</th><th>% of billing base</th><th>Amount</th><th>GST</th><th>Total</th><th>Acceptance required</th></tr></thead><tbody><tr><td><b>${esc(m.name)}</b><div class="sub">${esc(po.title)}</div></td><td>${fmtD(m.planned)}</td><td>${fmtNum(m.pct)}%</td><td>${fmtNum(m.amount)}</td><td>${gstOf(po)}%</td><td>${fmtNum(r2(m.amount + gst))}</td><td>${esc(accCell)}${m.allowPartial ? '<div class="sub">Partial invoicing allowed</div>' : ''}${m.requireCompleteQty ? '<div class="sub">Complete quantity only</div>' : ''}</td></tr></tbody></table></div>
  <div class="rc-sum"><div><b>Milestone Amount</b><span>${fmtNum(m.amount)}</span></div><div><b>Tax</b><span>${fmtNum(gst)}</span></div><div><b>Total Milestone Amount</b><span>${fmtNum(r2(m.amount + gst))}</span></div></div>
  <div style="height:18px"></div>`;
  const subs = (m.submissions || []).slice().reverse();
  const evidence = `<div class="sec-h">${m.needsDoc ? esc(dt) + ' · evidence' : 'Completion evidence'} <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0">· ${m.needsDoc ? 'mandatory; approved together with the milestone (not a goods / service receipt)' : 'optional'}</span></div>
    <div class="card flat">${subs.map(x => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><b>Submission ${x.v}</b> ${sb(x.status)}<span class="hint">${esc(x.by)} · ${fmtDT(x.at)}${x.remarks ? ' — ' + esc(x.remarks) : ''}${x.reason ? ' · ' + esc(x.reason) : ''}</span><span class="spacer"></span>${x.files.length ? attachChips(x.files) : '<span class="hint">no files</span>'}</div>`).join('') || '<div class="hint">Nothing submitted yet.</div>'}
    ${canSubmit ? `<div class="fgrid" style="margin-top:14px">${F.text('Completion date', 'actualDate', { type: 'date', req: 1 })}</div><div class="field"><label>${m.needsDoc ? `Upload ${esc(dt)}` : 'Evidence'} ${m.needsDoc ? '<span class="req">*</span>' : '(optional)'}</label>${attachBox('evFiles', f.evFiles)}</div>${F.area('Remarks (optional)', 'remarks', { ph: 'What was completed?' })}` : ''}
    ${m.needsDoc && d && d.status === 'Approved' && m.status === 'Approved' ? `<div class="row" style="margin-top:12px">${gbtn('ms.decide', 'ms-doc-revoke', 'Withdraw document approval', { cls: 'btn-outline btn-sm', data: { id: m.id } })}<span class="hint">If the approved document is later found wrong the gate reopens.</span></div>` : ''}</div>`;
  const rec = (m.needsGrn ? msReceiptCard(m, po, 'grn', u) : '') + (m.needsSrn ? msReceiptCard(m, po, 'srn', u) : '');
  const gu = m.needsGuarantee ? guaranteeCard(m.guarantee, m.guaranteeTitle, { upload: po.status === 'Approved' && !(u.value > EPS) }, m, 'ms') : '';
  const decide = msAwaiting(m) ? `<div class="card tint" style="margin-bottom:18px"><div class="card-t">Review this milestone</div><div class="hint" style="margin:-4px 0 12px">Approving ${m.code} (${money(m.amount)}) ${m.needsDoc ? `also approves the ${esc(dt)}. ` : ''}${g.conds.some(c => !c.soft && c.key !== 'doc' && !c.ok) ? `Invoicing will still wait for: ${esc(g.conds.filter(c => !c.soft && c.key !== 'doc' && !c.ok).map(condShort).join(' and '))}.` : 'It becomes invoice-eligible straight away.'}</div><div class="row">${m.status === 'Submitted for Approval' ? gbtn('ms.decide', 'ms-review', 'Start review', { cls: 'btn-outline', data: { id: m.id } }) : ''}${gbtn('ms.decide', 'ms-info', 'Request info', { cls: 'btn-outline', data: { id: m.id } })}${gbtn('ms.decide', 'ms-reject', 'Reject', { cls: 'btn-danger', data: { id: m.id } })}${gbtn('ms.decide', 'ms-approve', 'Approve milestone', { cls: 'btn-primary', data: { id: m.id }, icn: 'check' })}</div></div>` : '';
  const warn = ['Pending', 'In Progress', 'Submitted for Approval', 'Under Review'].includes(m.status) ? msSeqWarn(m, po) : '', ag = msAging(m);
  const notes = (warn ? alertBox('warn', 'Advisory', warn + ' It can still proceed; invoicing follows its own gates.') : '') + (ag && ag.level !== 'ok' ? alertBox(ag.level === 'escalated' ? 'err' : 'warn', ag.level === 'escalated' ? 'Escalated' : 'Reminder sent', `Waiting for the approver for ${ag.days} day(s)${ag.level === 'escalated' ? ' — escalated to the Procurement Manager.' : '.'}`) : '');
  const approvedBase = u.committedValue || 0;
  return `${head}${need}${stBanner(banner[0], banner[1], banner[2])}${notes}${decide}
  ${strip([['Approved value', money(ent), ent > 0 ? 'cleared for invoicing' : 'not yet eligible'], ['Invoiced · approved', money(approvedBase)], ['Reserved · in approval', money(u.reservedValue || 0), u.invs.map(invRef).join(', ')], ['Remaining invoiceable', money(avail), `of ${fmtNum(m.amount)} milestone`, avail > EPS ? 'hl' : '']])}
  <div class="sec-h">Progress</div><div class="checklist">${check.map(([ok, t, dd]) => `<div class="it"><div class="ci ${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x', 11, 3)}</div><div><div class="strong">${t}</div><div class="d">${dd}</div></div></div>`).join('')}</div>
  ${msTimingBlock(m, po)}${msScopeTable(m, po, g)}${evidence}${gu}${rec}${msAdvanceBlock(m, po)}
  ${u.invs.length ? `<div class="sec-h">Invoices</div>${allocsOn('milestone', m.id).map(({ inv, a }) => `<div class="row" style="padding:5px 0">${invLink(inv)} <span class="hint">${esc(inv.number)}</span> ${sb(inv.status)}<span class="spacer"></span><b>${money(a.value)}</b></div>`).join('')}` : ''}
  <div class="sec-h">History</div>${histList(`${po.number} / ${m.code}`, po.id)}`;
}
function msPanelFoot(m) {
  const po = getPO(m.poId), ent = msEnt(m, po), u = usage('milestone', m.id), a = [];
  if (m.status === 'Pending' && po.status === 'Approved') a.push(gbtn('ms.start', 'ms-start', 'Start work', { cls: 'btn-outline', data: { id: m.id } }));
  if (['Pending', 'In Progress', 'Rejected'].includes(m.status) && po.status === 'Approved') a.push(gbtn('ms.submit', 'ms-submit', m.status === 'Rejected' ? 'Resubmit for approval' : 'Submit for approval', { cls: 'btn-primary', data: { id: m.id }, icn: 'upload' }));
  if (msAwaiting(m)) { if (m.status === 'Submitted for Approval') a.push(gbtn('ms.decide', 'ms-review', 'Start review', { cls: 'btn-outline', data: { id: m.id } })); a.push(gbtn('ms.decide', 'ms-info', 'Request info', { cls: 'btn-outline', data: { id: m.id } }), gbtn('ms.decide', 'ms-reject', 'Reject', { cls: 'btn-danger', data: { id: m.id } }), gbtn('ms.decide', 'ms-approve', 'Approve', { cls: 'btn-primary', data: { id: m.id }, icn: 'check' })); }
  if (po.status === 'Approved' && !msLocked(m)) a.push(gbtn('po.amend', 'ms-amend', 'Edit scope & gates', { cls: 'btn-outline', data: { id: m.id }, icn: 'edit' }));
  if (ent - u.value > EPS && sourceItems(po).find(q => q.refId === m.id && q.eligible)) a.push(gbtn('inv.create', 'inv-new', `Submit Invoice for ${m.code}`, { cls: 'btn-primary', data: { po: po.id, ms: m.id }, icn: 'receipt' }));
  return a.join('');
}
ACT['ms-start'] = el => done(A.msStart(el.dataset.id));
ACT['ms-submit'] = el => { const f = ui.f; done(A.msSubmit(el.dataset.id, { actualDate: f.actualDate, remarks: f.remarks, files: f.evFiles }), () => { f.evFiles = []; f.remarks = ''; }); };
ACT['ms-review'] = el => done(A.msStartReview(el.dataset.id));
ACT['ms-approve'] = el => { const m = getMS(el.dataset.id), po = getPO(m.poId), pend = msGate(m, po).conds.filter(c => !c.soft && c.key !== 'doc' && !c.ok); confirmBox({ title: 'Approve milestone', message: `Approve <b>${esc(msFull(m))}</b> (${money(m.amount)})?${m.needsDoc ? ` This also approves the <b>${esc(docTitleOf(m))}</b>.` : ''} ${pend.length ? `Invoicing will stay blocked until: ${esc(pend.map(condShort).join(' and '))}.` : 'It becomes invoice-eligible.'}`, confirmLabel: 'Approve', onConfirm: () => done(A.msApprove(m.id)) }); };
ACT['ms-info'] = el => reasonModal({ title: 'Request information', label: 'What information is needed?', btn: 'Send back to supplier', danger: false, ph: 'e.g. signed page 3 is missing', onSubmit: note => { done(A.msRequestInfo(el.dataset.id, note)); } });
ACT['ms-reject'] = el => reasonModal({ title: 'Reject milestone', label: 'Rejection reason', btn: 'Reject milestone', ph: 'e.g. certificate unsigned', onSubmit: reason => { done(A.msReject(el.dataset.id, reason)); } });
ACT['ms-unlink'] = el => done(A.msUnlinkReceipt(el.dataset.id, el.dataset.rec));
ACT['ms-link'] = el => {
  const m = getMS(el.dataset.id), po = getPO(m.poId), kind = el.dataset.kind, g = kind === 'grn', N = kind.toUpperCase();
  const list = (g ? grnsOf(po) : srnsOf(po)).filter(r => r.status !== 'Rejected' && !r.reversed && inScope(m, r.lineId) && !linksOf(r).some(x => x.msId === m.id));
  const opts = [['', `— Select ${N} —`], ...list.map(r => [r.id, `${r.number} · ${(lineOf(po, r.lineId) || {}).desc} · ${g ? fmtNum(r.received) + ' units' : money(r.serviceValue)} · ${g ? grnStatus(r) : r.status}${linksOf(r).length ? ' (linked to ' + linksOf(r).map(x => (getMS(x.msId) || {}).code + (x.cap != null ? ' ' + fq(x.cap) : '')).join(', ') + ')' : ''}`])];
  openModal({ title: `Link ${N} to ${m.code}`, submitLabel: 'Link', html: fld(N, 'rec', { opts, value: '' }) + fld(`${g ? 'Units' : 'Value'} of this ${N} allocated to ${m.code} (optional)`, 'cap', { type: 'number', step: 'any', hint: `Leave empty to count every accepted ${g ? 'unit' : 'rupee'}. Give an explicit ${g ? 'quantity' : 'value'} on each link to let one receipt back several milestones — no unit can back two.` }) + `<p class="hint" style="margin-top:6px">Only receipts for lines in the scope of ${m.code} are listed. A milestone can have several ${N}s (staged deliveries).</p>`, onSubmit: v => { if (!v.rec) { toast(`Select a ${N}`, 'err'); return false; } done(A.msLinkReceipt(m.id, v.rec, false, { cap: v.cap })); } });
};

/* ================================================================ certified progress claims (Services) */
function claimsBlock(po, s) {
  const cs = claimsOf(po), cum = cumCertified(po);
  return `<div class="sec" style="margin-top:22px">Progress claims<span class="sub">Certified work progress — current claim = new cumulative − previously certified</span><span class="spacer"></span>${po.status === 'Approved' ? gbtn('claim.create', 'claim-new', 'New progress claim', { cls: 'btn-primary', data: { po: po.id }, icn: 'plus' }) : ''}</div>
  ${strip([['PO value', money(s.value)], ['Cumulative certified', money(cum), `${fmtNum(pct(cum, s.value))}% of PO`], ['Invoiced', money(s.invoiced)], ['Ready to invoice', money(s.remaining), 'certified − invoiced', 'hl']])}
  <div class="tbl-wrap" style="margin-top:16px"><table class="tbl"><thead><tr><th>Claim</th><th>Period</th><th class="right">Previously certified</th><th class="right">Current claim</th><th class="right">Cumulative claimed</th><th class="right">Certified</th><th>Status</th><th>Invoice</th><th class="right">Ready to invoice</th><th></th></tr></thead><tbody>
  ${cs.map(c => { const v = claimView(c), u = usage('claim', c.id); return `<tr class="click" data-act="claim-open" data-id="${c.id}"><td class="strong">${c.number}</td><td>${esc(c.period)}</td><td class="num">${fmtNum(v.prev)}</td><td class="num">${fmtNum(v.current)}</td><td class="num">${fmtNum(v.cum)}</td><td class="num">${c.status === 'Certified' ? fmtNum(v.certified) : '—'}</td><td>${sb(c.status)}</td><td>${u.invs.map(invLink).join(', ') || '—'}</td><td class="num strong">${c.status === 'Certified' ? fmtNum(v.remaining) : '—'}</td><td class="act"><button class="btn-view" data-act="claim-open" data-id="${c.id}">${icon('open', 12, 2)}View</button></td></tr>`; }).join('') || emptyRow(10, 'No progress claims yet.')}</tbody></table></div>`;
}
ACT['claim-new'] = el => {
  const poId = el.dataset.po;
  openPanel({ key: 'claim-new', title: 'New progress claim', sub: 'Claim cumulative progress for certification',
    init: () => ({ poId, period: `${MONTHS[new Date().getMonth()]} ${new Date().getFullYear()}`, claimedCum: '', remarks: '', evidence: [] }),
    body: () => { const f = ui.f, po = getPO(poId);
      return `<div class="fgrid">${F.ro('Purchase order', `<b>${esc(po.number)}</b>&nbsp;${esc(getSup(po.supplierId).name)}`, { cls: 'span2' })}${F.ro('PO value', money(poNet(po)))}${F.ro('Previously certified (cumulative)', money(cumCertified(po)))}
      ${F.text('Claim period', 'period', { req: 1 })}${F.text('New cumulative claimed (INR)', 'claimedCum', { type: 'number', step: 'any', num: 1, req: 1, ph: 'e.g. 50000' })}</div>
      <div class="field"><label>Current claim (derived)</label><div class="ro strong" id="c-cur"></div><div class="fhint">= new cumulative − previously certified</div></div><div id="rc-val"></div>
      ${F.area('Remarks', 'remarks')}<div class="field"><label>Supporting evidence <span class="req">*</span></label>${attachBox('evidence', f.evidence)}</div>`; },
    foot: () => gbtn('claim.create', 'claim-save', 'Submit for certification', { cls: 'btn-dark' }),
    derive: () => { const f = ui.f, po = getPO(f.poId), prev = cumCertified(po), cum = +f.claimedCum || 0, c = $('#c-cur'); if (!c) return;
      c.textContent = money(cum ? r2(cum - prev) : 0);
      $('#rc-val').innerHTML = cum && cum <= prev + EPS ? alertBox('err', 'Already certified', `${money(prev)} has already been certified. The new cumulative value must exceed it.`) : cum > poNet(po) + EPS ? alertBox('err', 'Exceeds PO value', `Cumulative claimed value exceeds the PO value ${money(poNet(po))}.`) : alertBox('info', '', `Maximum claimable now: ${money(r2(poNet(po) - prev))}. Value becomes invoice-eligible only once certified.`); } });
};
ACT['claim-save'] = () => { const f = ui.f; done(A.createClaim({ ...f, claimedCum: +f.claimedCum || 0 }), () => { closePanel(); go(`#/po/${f.poId}?tab=billing`); }); };
ACT['claim-open'] = el => {
  const id = el.dataset.id, get = () => getClaim(id);
  openPanel({ key: 'claim-' + id, mid: true, title: () => `${get().number} · ${get().period}`, sub: () => esc(getPO(get().poId).number),
    body: () => { const c = get(), po = getPO(c.poId), v = claimView(c), u = usage('claim', c.id);
      const bn = { Submitted: ['blue', 'Awaiting certification', 'Not invoice-eligible until certified.'], Certified: ['green', 'Certified', `${money(v.certified)} certified — ${money(v.remaining)} still to invoice.`], Rejected: ['red', 'Rejected', c.rejectReason || ''] }[c.status];
      return `${stBanner(bn[0], bn[1], bn[2])}${strip([['Previously certified', money(v.prev)], ['Cumulative claimed', money(v.cum)], ['Current claim', money(v.current), `${fmtNum(v.cum)} − ${fmtNum(v.prev)}`], ['Certified', c.status === 'Certified' ? money(v.certified) : '—'], ['Ready to invoice', money(v.remaining), '', 'hl']])}
      <div class="sec-h">Details</div><div class="kvg c2">${kv('PO', poLink(po))}${kv('Period', esc(c.period))}${kv('Remarks', esc(c.remarks) || '—')}${kv('Evidence', attachChips(c.evidence) || '—')}${kv('Invoices', u.invs.map(invLink).join(', ') || '—')}</div>
      <div class="sec-h">History</div>${histList(c.number, po.id)}`; },
    foot: () => { const c = get(), po = getPO(c.poId), v = claimView(c), a = [];
      if (c.status === 'Submitted') a.push(gbtn('claim.decide', 'claim-reject', 'Reject', { cls: 'btn-danger', data: { id } }), gbtn('claim.decide', 'claim-certify', 'Certify claim', { cls: 'btn-primary', data: { id }, icn: 'check' }));
      if (c.status === 'Certified' && v.remaining > EPS) a.push(gbtn('inv.create', 'inv-new', 'Submit Invoice', { cls: 'btn-primary', data: { po: po.id }, icn: 'receipt' }));
      return a.join(''); } });
};
ACT['claim-reject'] = el => reasonModal({ title: 'Reject progress claim', label: 'Rejection reason', btn: 'Reject claim', onSubmit: reason => { done(A.rejectClaim(el.dataset.id, reason)); } });
ACT['claim-certify'] = el => { const c = getClaim(el.dataset.id), v = claimView(c); openModal({ title: `Certify ${c.number}`, submitLabel: 'Certify', html: `<p style="margin-bottom:12px">Cumulative claimed ${money(v.cum)} − previously certified ${money(v.prev)} = current claim <b>${money(v.current)}</b>. Only this newly certified value becomes invoice-eligible.</p>${fld('Certified value (INR)', 'val', { type: 'number', value: v.current, step: 'any' })}`, onSubmit: x => { const r = A.certifyClaim(c.id, +x.val); if (!r.ok) { toast(r.msg, 'err'); return false; } toast(r.msg); render(); } }); };
