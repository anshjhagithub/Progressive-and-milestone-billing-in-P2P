/* =====================================================================
   screens-po.js — PO list, create / edit drawer (incl. milestone schedule), PO detail
   ===================================================================== */
const notFound = what => `<div class="page">${pageHead({ title: `${what} not found` })}<div class="empty-state">That record does not exist (the demo data may have been reset).<br><br>${actBtn('go', 'Go to purchase orders', { cls: 'btn-primary', data: { hash: '#/pos' } })}</div></div>`;
const MS_COLORS = ['#6A5BD2', '#2FA06B', '#E0A030', '#2E7DBA', '#B0285A', '#7B5BA8', '#3E8E95', '#C2583A'];
const recName = po => recLabel(po);                                         // GRN / SRN / GRN / SRN (mixed)
const poValueGross = po => { const n = poNet(po); return r2(n + n * gstOf(po) / 100); };

/* ---------------------------------------------------------------- list */
ROUTES.pos = () => `<div class="page"><h1 class="page-title">Purchase Order</h1>
  ${listHtml('pos', {
    noun: 'POs', searchPh: 'Search PO number, vendor, title…', defaults: {},
    tabs: [['pending', 'Pending', p => !poIsPast(p)], ['past', 'Past', p => poIsPast(p)], ['all', 'All Orders', () => true]],
    filters: [
      { name: 'method', label: 'Billing', options: () => ['Standard', 'Progressive', 'Milestone'] },
      { name: 'type', label: 'Type', options: () => ['Goods', 'Services'] },
      { name: 'supplier', label: 'Vendor', options: () => supOpts() }],
    above: gbtn('po.edit', 'po-new', 'Create Order', { cls: 'btn-primary', icn: 'plus' }),
    rows: () => db.pos.slice().sort((a, b) => (b.seqNo || 0) - (a.seqNo || 0)),
    match: (p, st) => matchText(st, p.number, getSup(p.supplierId).name, p.title, p.lines.map(l => l.desc).join(' ')) && matchIn(st, 'method', p.billingMethod) && matchIn(st, 'type', p.type) && matchIn(st, 'supplier', p.supplierId),
    cols: ['PO Number', 'Vendor Name', 'Type', 'Category', 'Office', 'Billing', 'Status', 'Created On', 'Submitted By', '>Amount', ''],
    row: p => { const s = p.status === 'Approved' ? poSummary(p) : null, val = poNet(p);
      return `<tr class="click" data-act="go" data-hash="#/po/${p.id}"><td class="id strong"><span class="pono">${esc(p.number)}${p.version > 1 ? ` <span class="badge-s s-gray">v${p.version}</span>` : ''}<span class="eye">${icon('eye', 15)}</span></span></td><td class="soft">${esc(getSup(p.supplierId).name)}</td><td>${typeBadge(p)}</td><td class="soft">${esc(p.category)}</td><td class="soft">${esc(officeOf(p.office).name)}</td><td>${poMethodBadge(p)}</td><td>${stagePill(p)}</td><td class="soft">${fmtD(p.poDate)}<br>${fmtT(p.createdAt)}</td><td class="soft">${esc(p.createdBy)}</td>
      <td class="num soft">${money(val)}${s ? `<div class="mini-bar" style="margin-left:auto"><span style="width:${pct(s.invoiced, val).toFixed(1)}%"></span></div><div class="sub">${fmtNum(pct(s.invoiced, val), 0)}% billed</div>` : ''}</td><td class="act">${viewBtn(`#/po/${p.id}`)}</td></tr>`; },
  })}</div>`;
ACT['po-new'] = () => openPoPanel(null);
ACT['po-edit'] = el => openPoPanel(el.dataset.id);

/* ---------------------------------------------------------------- router */
ROUTES.po = r => { const po = getPO(r.parts[1]); if (!po) return notFound('Purchase order'); return poDetail(po, r); };

/* ---------------------------------------------------------------- create / edit drawer */
const newLineId = () => `ln_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const blankLine = () => ({ id: newLineId(), outside: false, desc: '', qty: 1, uom: ui.f && ui.f.type === 'Services' ? 'Lot' : 'Units', price: '', kind: ui.f && ui.f.type === 'Services' ? 'Services' : 'Goods' });
const poDraftBlank = () => ({ id: null, supplierId: '', buyer: 'DICE Manufacturing Pvt Ltd', office: OFFICES[0].id, title: '', poDate: todayISO(), deliveryDate: daysFromNow(30), endDate: '', type: 'Goods', category: CATEGORIES[0], gstRate: GST_DEFAULT,
  billingMethod: 'Standard', progressBasis: 'Receipt', lines: [], milestones: [], attachments: [], settings: { ...PO_DEFAULTS } });
const poDraftExisting = po => ({ id: po.id, supplierId: po.supplierId, buyer: po.buyer, office: po.office, title: po.title, poDate: po.poDate, deliveryDate: po.deliveryDate, endDate: po.endDate || '', type: po.type, category: po.category, gstRate: po.gstRate,
  billingMethod: po.billingMethod, progressBasis: po.progressBasis, lines: po.lines.map(l => ({ ...l })), milestones: msOf(po).map(m => ({ ...m, scope: (m.scope || []).map(x => ({ ...x })), advance: { ...(m.advance || {}) }, dependsOn: [...(m.dependsOn || [])] })), attachments: [...(po.attachments || [])], settings: { ...PO_DEFAULTS, ...(po.settings || {}) } });
const fVal = f => r2(f.lines.reduce((s, l) => s + (+l.qty || 0) * (+l.price || 0), 0));
const EXAMPLE_SCHEDULE = f => [
  { name: 'Design approval', pct: 20, planned: daysFromNow(30) },
  { name: f.type === 'Services' ? 'Works completed' : 'Equipment delivered', pct: 50, planned: daysFromNow(75), needsGrn: f.type !== 'Services', needsSrn: f.type === 'Services' },
  { name: 'Commissioning & handover', pct: 30, planned: daysFromNow(110), needsDoc: true, docTitle: 'Commissioning Certificate' },
];
function openPoPanel(id) {
  const po = id && getPO(id);
  openPanel({ key: 'po', title: po ? `Edit ${po.number}` : 'Create PO Order', sub: 'Fill out the details', init: () => po ? poDraftExisting(po) : poDraftBlank(), body: poPanelBody, foot: poPanelFoot, derive: poDerive });
}
HOOKS.potype = (el, v) => { if (v !== 'Services' && ui.f.progressBasis === 'Certified') ui.f.progressBasis = 'Receipt'; ui.f.lines.forEach(l => { l.kind = v === 'Mixed' ? (l.kind || 'Goods') : v; }); };
function poPanelBody() {
  const f = ui.f, off = officeOf(f.office), m = f.billingMethod, goods = f.type !== 'Services', mixed = f.type === 'Mixed', recs = f.type === 'Goods' ? 'GRNs' : f.type === 'Services' ? 'SRNs' : 'GRNs / SRNs';
  const card = (k, t, d) => `<button type="button" class="opt ${m === k ? 'on' : ''}" data-act="po-method" data-m="${k}"><div class="t"><span class="dot"></span>${t}</div><div class="d">${d}</div></button>`;
  return `
  <div class="fgrid">
    ${F.select('PO Type', 'type', [['Goods', 'Goods'], ['Services', 'Services'], ['Mixed', 'Mixed (goods + services)']], { req: 1, r: 1, hook: 'potype' })}
    ${F.select('Select Vendor', 'supplierId', supOpts(), { req: 1, blank: 'Select Vendor' })}
    ${F.text('Enter Order Title', 'title', { req: 1, ph: 'Order Title' })}
    ${F.select('Select Category', 'category', CATEGORIES.map(c => [c, c]))}
    ${F.select('Billing Office', 'office', officeOpts(), { r: 1, req: 1 })}
    ${F.ro('Currency', 'INR — Indian Rupee')}
    ${F.text('Delivery Date', 'deliveryDate', { type: 'date', req: 1 })}
    ${F.text('End Date (Optional)', 'endDate', { type: 'date' })}
    ${F.select('GST', 'gstRate', GST_RATES.map(r => [r, r + '%']))}
    ${F.ro('Bill Address', `<span style="font-size:12.5px;line-height:1.4;padding:8px 0">${esc(off.address)}<br><span class="muted">GSTIN: ${off.gstin}</span></span>`, { cls: 'span2' })}
  </div>
  <div class="sec-h" style="text-transform:none;font-size:13px;font-weight:500;margin-bottom:8px">Line Items<span class="req" style="color:var(--danger)">*</span></div>
  <table class="li-table"><thead><tr><th>Details</th>${mixed ? '<th style="width:96px">Type</th>' : ''}<th style="width:64px">Qty</th><th style="width:82px">UoM</th><th style="width:100px">Unit Price</th><th style="width:78px">GST</th><th style="width:96px">Total</th>${m === 'Milestone' ? '<th style="width:74px" title="Tick for lines that bill on accepted receipts instead of the milestone schedule (e.g. consumables)">Outside</th>' : ''}<th style="width:52px">Action</th></tr></thead><tbody>
  ${f.lines.map((l, i) => `<tr>
    <td><input class="input" data-f="lines.${i}.desc" value="${esc(l.desc)}" placeholder="${f.type === 'Services' || l.kind === 'Services' ? 'Service description' : 'Item description'}"></td>
    ${mixed ? `<td><select class="input" data-f="lines.${i}.kind" data-r>${opt([['Goods', 'Goods'], ['Services', 'Services']], l.kind || 'Goods')}</select></td>` : ''}
    <td><input class="input num" type="number" min="0" step="any" data-t="num" data-f="lines.${i}.qty" value="${l.qty}"></td>
    <td><select class="input" data-f="lines.${i}.uom">${opt(UOMS, l.uom)}</select></td>
    <td><input class="input num" type="number" min="0" step="any" data-t="num" data-f="lines.${i}.price" value="${l.price}" placeholder="0.00"></td>
    <td><select class="input sm" data-f="lines.${i}.gstRate" title="Tax rate of this line — leave on the PO rate unless the line differs"><option value="">${f.gstRate}%</option>${GST_RATES.filter(x => x !== +f.gstRate).map(x => `<option value="${x}" ${String(l.gstRate) === String(x) ? 'selected' : ''}>${x}%</option>`).join('')}</select></td>
    <td class="num strong" id="li-amt-${i}"></td>
    ${m === 'Milestone' ? `<td style="text-align:center"><input type="checkbox" data-f="lines.${i}.outside" data-r ${l.outside ? 'checked' : ''} title="Billed outside the milestone schedule"></td>` : ''}
    <td style="text-align:center"><button type="button" class="icon-btn danger" data-act="ln-del" data-i="${i}" title="Remove line">${icon('trash', 15)}</button></td></tr>`).join('') || `<tr><td class="empty" colspan="${(mixed ? 8 : 7) + (m === 'Milestone' ? 1 : 0)}">No Line Items Added</td></tr>`}</tbody></table>
  ${m === 'Milestone' && f.lines.length ? `<details class="mm-sec ctl"><summary><b>Unit conversions</b><span class="hint">optional — lets a supplier invoice in another unit (e.g. Box = 10)</span></summary><div class="mm-body">${f.lines.map((l, i) => `<div class="fgrid" style="align-items:center"><div class="soft" style="font-size:12.5px">L${i + 1} ${esc(l.desc || '(item)')} — priced per ${esc(l.uom)}</div><input class="input sm" data-f="lines.${i}.convsText" value="${esc(l.convsText != null ? l.convsText : convsStr(l.convs))}" placeholder="e.g. Box=10, Carton=120  (1 Box = 10 ${esc(l.uom)})"></div>`).join('')}</div></details>` : ''}
  <div class="li-actions"><button type="button" class="btn btn-green btn-sm" data-act="ln-add">${icon('plus', 13, 2.2)}Add Line Item</button><button type="button" class="stub-btn" data-act="stub" data-name="Bulk Upload">${icon('upload', 14)}Bulk Upload</button></div>
  <div class="li-total" id="li-total"></div>
  <div class="sec-h">Billing method</div>
  <div class="seg-cards">
    ${card('Standard', 'Standard', `Invoice against accepted ${recLabel(f)} value at PO level.`)}
    ${card('Progressive', 'Progressive', 'Many invoices over time, each against accepted work.')}
    ${card('Milestone', 'Milestone', 'Invoices follow a fixed schedule of milestones.')}
  </div>
  ${m === 'Progressive' ? `<div class="field" style="margin-top:14px"><label>Progress is measured by</label><div class="seg-cards" style="grid-template-columns:1fr 1fr">
    <button type="button" class="opt ${f.progressBasis !== 'Certified' ? 'on' : ''}" data-act="po-basis" data-b="Receipt"><div class="t"><span class="dot"></span>Accepted ${recs}</div><div class="d">Each accepted receipt becomes invoice-eligible.</div></button>
    <button type="button" class="opt ${f.progressBasis === 'Certified' ? 'on' : ''}" data-act="po-basis" data-b="Certified" ${f.type !== 'Services' ? 'disabled title="Certified work progress is only available for Services POs"' : ''}><div class="t"><span class="dot"></span>Certified work progress</div><div class="d">${f.type !== 'Services' ? 'Services POs only.' : 'Vendor claims cumulative progress; buyer certifies.'}</div></button></div></div>` : ''}
  ${m === 'Milestone' ? msEditor(f) : ''}
  <div class="sec-h" style="text-transform:none;font-size:14px;font-weight:700">Additional Attachment</div>${attachBox('attachments', f.attachments)}`;
}
/* milestone schedule in the Create PO drawer — same pattern as DICE line items: read-only table, Edit / Delete, "+ Add Milestone" dialog */
const accChips = m => { const acc = [m.needsDoc ? `<span class="acc-chip doc">${icon('doc', 12, 2)}${esc(m.docTitle || 'Document')} approved</span>` : '', m.needsGuarantee ? `<span class="acc-chip doc">${icon('lock', 12, 2)}${esc(m.guaranteeTitle || 'Guarantee')} verified</span>` : '', m.needsGrn ? `<span class="acc-chip rec">${icon('box', 12, 2)}Accepted GRN</span>` : '', m.needsSrn ? `<span class="acc-chip rec">${icon('truck', 12, 2)}Accepted SRN</span>` : '', m.requireCompleteQty ? '<span class="acc-chip rec">Complete quantity</span>' : '', m.trigger && m.trigger.lineId ? `<span class="acc-chip rec">${icon('box', 12, 2)}Fires at ${fq(m.trigger.qty)} cumulative</span>` : ''].filter(Boolean);
  return (acc.length ? acc.join('') : '<span class="dim-note">Approval only</span>') + (m.allowPartial ? '<span class="acc-chip part">Partial invoicing</span>' : '') + (m.advance && m.advance.allowed ? `<span class="acc-chip part">Advance ${fmtNum(m.advance.value)}${m.advance.mode === 'percent' ? '%' : ''}</span>` : '') + (m.closing ? '<span class="acc-chip part">Closes the PO</span>' : ''); };
/* timing cell of a draft milestone: due date, duration and what it waits for */
const depChips = m => depList(m).map(d => `<span class="dep-chip ${d.effect}" title="${esc(DEP_TYPES[d.type])}${d.lag ? ', ' + (d.lag > 0 ? '+' : '') + d.lag + ' days' : ''} · ${esc(DEP_EFFECTS[d.effect])}">${esc(d.pred)} ${d.type}${d.lag ? (d.lag > 0 ? '+' : '') + d.lag : ''}${d.effect !== 'schedule' ? ' ' + icon('lock', 10, 2.4) : ''}</span>`).join('');
const timingCell = m => `<div>${m.planned ? fmtD(m.planned) : '<span class="dim-note">no date</span>'}${+m.durationDays ? ` <span class="sub">· ${m.durationDays}d</span>` : ''}</div>${depChips(m) ? `<div class="dep-chips">${depChips(m)}</div>` : ''}`;
/* one place that knows how a draft schedule is valid: simple "% of PO" milestones use the percentage check, line-scoped ones the coverage check */
function schedView(f) {
  ensureLineIds(f.lines);
  const explicit = f.milestones.some(explicitScope), base = scheduleBase(f.lines), allOut = !f.lines.some(l => !isOutside(l)) && f.lines.length > 0;
  if (!explicit) { const chk = scheduleCheck(f.milestones, base), amts = chk.ok ? chk.amounts : f.milestones.map(m => r2((+m.pct || 0) * base / 100));
    const errors = allOut ? ['Every line is billed outside the schedule — nothing is left to schedule.'] : chk.errors; return { explicit, base, amounts: amts, pctTotal: chk.pctTotal, errors, ok: chk.ok && !allOut, coverage: [] }; }
  const sch = buildSchedule(f.lines, f.milestones); const errors = [...sch.errors]; if (sch.ok) advanceTermErrors(f, sch.amounts).forEach(e => errors.push(e));
  return { explicit, base, amounts: sch.amounts, pctTotal: base ? r2(sum(sch.amounts, x => x) / base * 100) : 0, errors, ok: !errors.length, coverage: sch.coverage };
}
const scopeSummary = (m, lines) => (m.simple !== false && !explicitScope(m)) ? `${fmtNum(+m.pct || 0)}% of every scheduled line` : (m.scope || []).map(x => { const l = lines.find(q => q.id === x.lineId); if (!l) return ''; const n = lines.indexOf(l) + 1; return `L${n} ${x.basis === 'quantity' ? fq(x.qty) + ' ' + l.uom : x.basis === 'percent' ? fq(x.percent) + '%' : money(x.amount)}`; }).filter(Boolean).join(' · ');
function msEditor(f) {
  const sv = schedView(f), amts = sv.amounts, anyOut = f.lines.some(isOutside);
  return `<div class="sec-h" style="text-transform:none;font-size:13px;font-weight:500;margin-bottom:8px">Milestone Schedule<span class="req" style="color:var(--danger)">*</span></div>
  <div id="ms-bar"></div>
  <table class="li-table ms-tbl"><thead><tr><th style="width:44px">ID</th><th>Milestone</th><th style="width:150px">Timeline</th><th style="width:112px">Amount</th><th>Conditions</th><th style="width:84px">Action</th></tr></thead><tbody>
  ${f.milestones.map((m, i) => `<tr><td><span class="ms-chip" style="background:${MS_COLORS[i % MS_COLORS.length]}">M${i + 1}</span></td><td><b>${esc(m.name || '(unnamed)')}</b><div class="sub">${esc(scopeSummary(m, f.lines))}</div></td><td>${timingCell({ ...m, code: 'M' + (i + 1) })}</td><td class="num"><b id="ms-amt-${i}">${fmtNum(amts[i] || 0)}</b><div class="sub" id="ms-pct-${i}">${fmtNum(sv.base ? r2((amts[i] || 0) / sv.base * 100) : 0)}%</div></td><td><div class="acc-chips">${accChips(m)}</div></td><td style="white-space:nowrap"><button type="button" class="link" data-act="ms-edit" data-i="${i}">Edit</button> <button type="button" class="link" style="color:var(--danger)" data-act="ms-del" data-i="${i}">Delete</button></td></tr>`).join('') || '<tr><td class="empty" colspan="6">No Milestones Added</td></tr>'}</tbody></table>
  <div class="li-actions" style="margin:4px 0 6px"><button type="button" class="addline" data-act="ms-add">+ Add Milestone</button>${f.milestones.length ? '' : `<button type="button" class="stub-btn" data-act="ms-example">Load example (design · delivery · commissioning certificate)</button>`}</div>
  <div id="ms-cov"></div>
  <p class="hint" style="margin:4px 0 0">A milestone covers a <b>scope</b> of PO lines — a quantity, a % of the line, or a lump sum — and its amount is <b>derived</b> from that scope. It can require accepted <b>GRN(s) / SRN(s)</b> for real receipts or <b>complete quantity</b>; a receipt is never created just to prove a certificate. ${anyOut ? 'Lines ticked <b>Outside</b> bill on accepted receipts and carry no scope. ' : ''}Partial invoicing and advances are set per milestone.</p>
  <details class="mm-sec ctl"><summary><b>Billing controls for this PO</b><span class="hint">advance caps, GST on advances, invoice due terms</span></summary><div class="mm-body">
  <div class="fgrid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
    <div class="field"><label>Max advance per milestone (%)</label><input class="input num" type="number" step="any" data-t="num" data-f="settings.maxAdvancePctPerMilestone" value="${esc(f.settings.maxAdvancePctPerMilestone)}"></div>
    <div class="field"><label>Max advances across the PO (%)</label><input class="input num" type="number" step="any" data-t="num" data-f="settings.maxAdvancePctOfPO" value="${esc(f.settings.maxAdvancePctOfPO)}"></div>
    <div class="field"><label>GST on advances</label><select class="input" data-f="settings.advanceGstMode">${opt([['taxed_on_advance', 'On the advance invoice'], ['taxed_at_final', 'At the final invoice']], f.settings.advanceGstMode)}</select></div>
    <div class="field"><label>Rate tolerance (%)</label><input class="input num" type="number" step="any" data-t="num" data-f="settings.valueTolerancePct" value="${esc(f.settings.valueTolerancePct)}"></div>
    <div class="field"><label>Invoice due counted from</label><select class="input" data-f="settings.dueBasis">${opt([['later', 'Later of receipt and acceptance'], ['receipt', 'Invoice receipt'], ['acceptance', 'Acceptance']], f.settings.dueBasis || 'later')}</select></div>
    <div class="field"><label>Due in (days)</label><input class="input num" type="number" step="1" data-t="num" data-f="settings.dueDays" value="${esc(f.settings.dueDays)}" placeholder="${dueTerms({ category: f.category, settings: {} }).days} (by category)"></div></div>
  <label class="check-row" style="margin:6px 0 0"><input type="checkbox" data-f="settings.enforceDependencies" ${f.settings.enforceDependencies ? 'checked' : ''}> Treat every dependency as a gate (otherwise only dependencies set to Gate / Both block)</label></div></details>
  <div id="ms-sum"></div>`;
}
/* the milestone editor — used when drafting a PO and, in amend mode, to re-assign the scope / gates of an unsubmitted milestone.
   Laid out as four short sections (Basics · Scope · Conditions & advance · Timing & dependencies); `ctx.timingOnly` shows just Basics' dates and the dependencies. */
const dItem = x => ({ code: x.code, planned: x.planned || '', durationDays: x.durationDays || 0, forecast: x.forecastDate || '', actualStart: x.startedAt ? String(x.startedAt).slice(0, 10) : '', actualFinish: x.status === 'Approved' && x.approvedAt ? String(x.approvedAt).slice(0, 10) : '', deps: Array.isArray(x.deps) ? x.deps : undefined, dependsOn: x.dependsOn });
const depTypeOpts = Object.entries(DEP_TYPES), depEffOpts = Object.entries(DEP_EFFECTS), depStateOpts = Object.entries(DEP_STATES);
function openMsEditor(ctx) {
  const { lines, type } = ctx, m = ctx.m, amend = !!ctx.amend, tOnly = !!ctx.timingOnly, base = scheduleBase(lines), sched = lines.filter(l => !isOutside(l));
  const canG = type !== 'Services' && (type === 'Goods' || lines.some(l => l.kind !== 'Services')), canS = type !== 'Goods' && (type === 'Services' || lines.some(l => l.kind === 'Services'));
  const st = { simple: amend ? false : (m ? !explicitScope(m) : true), rows: (m && (m.scope || []).length ? m.scope : []).map(x => ({ lineId: x.lineId, basis: x.basis, v: x.basis === 'quantity' ? x.qty : x.basis === 'percent' ? x.percent : x.amount })),
    deps: m ? depList(m).map(d => ({ ...d })) : [], join: m && m.depJoin === 'ANY' ? 'ANY' : 'ALL' };
  if (!st.rows.length && sched[0]) st.rows.push({ lineId: sched[0].id, basis: 'quantity', v: '' });
  const adv0 = (m && m.advance) || {}, others = (ctx.milestones || []).filter(x => !(m && x.code === m.code)), selfCode = (m && m.code) || ('M' + (ctx.nextSeq || others.length + 1));
  const opt3 = (name, on, title, desc) => `<label class="check-row accbox"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> <span><b>${title}</b><span class="hint" style="display:block">${desc}</span></span></label>`;
  const sec = (n, title, sub, body, open = true) => `<details class="mm-sec" ${open ? 'open' : ''}><summary><span class="mm-n">${n}</span><b>${title}</b><span class="hint">${sub}</span></summary><div class="mm-body">${body}</div></details>`;
  const lineLbl = l => `L${lines.indexOf(l) + 1} · ${l.desc || 'item'} — ${fmtNum(l.qty)} ${l.uom} × ${fmtNum(l.price)}`;
  const basics = `${tOnly ? `<div class="mm-ro"><b>${esc(m.code)}</b> ${esc(m.name)}</div>` : fld('Milestone name', 'name', { value: m ? m.name : '', ph: 'e.g. Equipment delivered', req: 1 })}
      <div class="fgrid3">${fld('Due date (finish)', 'planned', { type: 'date', value: m ? m.planned : '' })}${fld('Duration (days)', 'duration', { type: 'number', step: 1, value: m && m.durationDays ? m.durationDays : '', ph: '0', hint: 'start = finish − duration' })}${fld('Forecast finish', 'forecast', { type: 'date', value: m ? m.forecastDate : '', hint: 'only if running late' })}</div>`;
  const scope = `<div class="seg-cards"><button type="button" class="opt ${st.simple ? 'on' : ''}" data-mode="simple" ${amend ? 'disabled' : ''}><div class="t"><span class="dot"></span>Whole PO</div><div class="d">A % of every scheduled line.</div></button><button type="button" class="opt ${st.simple ? '' : 'on'}" data-mode="lines"><div class="t"><span class="dot"></span>Specific lines</div><div class="d">Pick lines and a quantity, % of the line, or a lump sum for each.</div></button></div>
      <div id="sc-simple" style="margin-top:12px"><div class="fgrid">${fld('Amount (INR)', 'amount', { type: 'number', step: 'any', value: m && m.pct && !explicitScope(m) ? r2((+m.pct || 0) * base / 100) : '', hint: `of the billing base ${money(base)}` })}${fld('% of the billing base', 'pct', { type: 'number', step: 'any', value: m && !explicitScope(m) ? m.pct : '', hint: 'Enter the amount or the percentage — the other fills in' })}</div></div>
      <div id="sc-lines" style="display:none;margin-top:12px"><table class="li-table"><thead><tr><th>Line</th><th style="width:120px">Basis</th><th style="width:104px">Value</th><th style="width:110px">Portion value</th><th style="width:36px"></th></tr></thead><tbody id="sc-rows"></tbody></table>
      <div class="li-actions" style="margin:4px 0"><button type="button" class="addline" id="sc-add">+ Add line to scope</button><span class="hint" id="sc-total" style="margin-left:auto;font-weight:600"></span></div><div id="sc-msg"></div></div>`;
  const cond = `${canG ? opt3('needsGrn', m && m.needsGrn, 'Accepted GRN', 'Goods received and accepted, linked to this milestone. Quantity portions count accepted units automatically.') : ''}
      ${canS ? opt3('needsSrn', m && m.needsSrn, 'Accepted SRN', 'Service delivery recorded and accepted, linked to this milestone.') : ''}
      ${canS ? opt3('autoSrn', m && m.autoSrn, 'Auto-create a system SRN when approved', 'Service portions only — keeps three-way matching consistent. Goods always need a real GRN.') : ''}
      ${canS ? opt3('measured', m && m.measured, 'Measured service — bill the accepted value', 'On: the invoice cannot exceed the accepted SRN value. Off (fixed price): the agreed amount is billed and the SRN is only evidence.') : ''}
      ${opt3('requireCompleteQty', m && m.requireCompleteQty, 'Complete quantity only', 'Billable only when 100% of the scoped quantity is accepted — no part supply.')}
      ${opt3('allowPartial', m && m.allowPartial, 'Allow partial invoicing', 'Invoice in several parts, each up to the remaining eligible balance. Off = one invoice for the full amount.')}
      <div class="hint">Tick any combination — none means the milestone is billable as soon as it is approved.</div>`;
  const adv = `${opt3('advAllowed', adv0.allowed, 'Allow an advance against this milestone', 'Paid early, then recovered from its invoices. The supplier requests it; an approver other than the requester approves.')}
      <div id="mm-adv" style="margin:6px 0 0 30px;${adv0.allowed ? '' : 'display:none'}"><div class="fgrid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="field"><label>Advance as</label><select class="input" name="advMode"><option value="percent" ${adv0.mode !== 'amount' ? 'selected' : ''}>% of the milestone</option><option value="amount" ${adv0.mode === 'amount' ? 'selected' : ''}>Fixed amount</option></select></div>
        <div class="field"><label>Value</label><input class="input" type="number" step="any" name="advValue" value="${esc(adv0.value || '')}" placeholder="e.g. 25"></div>
        <div class="field"><label>Recovery</label><select class="input" name="advRec"><option value="proportional" ${adv0.recovery !== 'first' ? 'selected' : ''}>Proportional</option><option value="first" ${adv0.recovery === 'first' ? 'selected' : ''}>From first invoice</option></select></div>
        <div class="field"><label>Guarantee</label><label class="check-row" style="margin-top:8px"><input type="checkbox" name="advGuar" ${adv0.guaranteeRequired ? 'checked' : ''}> Required</label></div></div>
        <div id="mm-advg" style="${adv0.guaranteeRequired ? '' : 'display:none'}"><input class="input" name="advGuarTitle" value="${esc(adv0.guaranteeTitle || '')}" placeholder="e.g. Advance payment guarantee"></div><div class="hint" id="adv-live" style="margin-top:6px"></div></div>`;
  const goodsLines = lines.filter(l => !isOutside(l) && l.kind !== 'Services' && type !== 'Services'), t0 = (m && m.trigger) || {};
  const trig = goodsLines.length ? `${opt3('trigOn', !!t0.lineId, 'Fire on cumulative accepted quantity', 'Eligible when the accepted GRNs of one line add up to a threshold — not on a date. The trigger decides <i>when</i>; the scope decides <i>what</i> is billed. Units beyond the threshold count toward the next portion.')}
      <div id="mm-trig" style="margin:0 0 8px 30px;${t0.lineId ? '' : 'display:none'}"><div class="fgrid"><div class="field"><label>Goods line</label><select class="input sm" name="trigLine">${goodsLines.map(l => `<option value="${l.id}" ${l.id === t0.lineId ? 'selected' : ''}>${esc(lineLbl(l))}</option>`).join('')}</select></div>${fld('Cumulative quantity reached', 'trigQty', { type: 'number', step: 'any', value: t0.qty || '', ph: 'e.g. 100', hint: 'needs a quantity row for this line in the scope' })}</div></div>` : '';
  const dm0 = (m && m.damages) || {};
  const dmg = `<div class="field" style="margin-top:12px"><label>Delay damages <span class="hint" style="text-transform:none;font-weight:400">· deducted from the payable when this milestone finishes after its due date</span></label><div class="fgrid">${fld('Rate (% of the milestone value per week or part)', 'dmgRate', { type: 'number', step: 'any', value: dm0.ratePct || '', ph: 'e.g. 0.5 — leave empty for none' })}${fld('Cap (% of the milestone value)', 'dmgCap', { type: 'number', step: 'any', value: dm0.capPct || '', ph: '10' })}</div></div>`;
  const dep = `<div class="hint" style="margin:0 0 8px"><b>Schedule</b> moves this milestone's dates · <b>Gate</b> blocks it (billing after a Finish→Start, starting after a Start→Start, approval after a Finish→Finish) · <b>Both</b> does both. A late date alone never blocks billing.</div>
      <div id="dp-rows"></div><div class="li-actions" style="margin:4px 0"><button type="button" class="addline" id="dp-add" ${others.length ? '' : 'disabled'}>+ Add dependency</button><span class="hint" id="dp-none">${others.length ? '' : 'Add another milestone first.'}</span></div>
      <div id="dp-join" style="display:none" class="field"><label>When several gates apply</label><select class="input sm" name="depJoin" style="max-width:300px"><option value="ALL" ${st.join === 'ALL' ? 'selected' : ''}>All of them must be met</option><option value="ANY" ${st.join === 'ANY' ? 'selected' : ''}>Any one of them is enough</option></select></div>
      ${dmg}
      ${opt3('closing', m && m.closing, 'Closing milestone', 'Cannot be approved until every other milestone is approved and every receipt is inspected — then the PO is reconciled.')}
      <div id="dp-msg" style="margin-top:8px"></div>`;
  const ov = openModal({ title: ctx.title, submitLabel: ctx.submitLabel, cls: 'xwide', html: `<p style="margin:-6px 0 12px;font-size:12.5px">${tOnly ? 'change the dates and dependencies' : 'fill out the details'}</p><div class="mm-secs">
    ${sec(1, 'Basics', tOnly ? 'due date, duration and forecast' : 'name and dates', basics)}
    ${tOnly ? '' : sec(2, 'Scope', 'what this milestone covers — its amount is derived from it', scope)}
    ${tOnly ? '' : sec(3, 'Conditions to invoice', 'receipts, quantity trigger and partial invoicing', cond + trig, true)}
    ${tOnly ? '' : sec(4, 'Advance', 'optional', adv, !!adv0.allowed)}
    ${sec(tOnly ? 2 : 5, 'Timing & dependencies', 'what this milestone waits for', dep, true)}</div>
    ${amend ? `<div class="field" style="margin-top:12px">${fld('Amendment reason', 'reason', { rows: 2, req: true, ph: 'Why is this changing?' })}</div>` : ''}`,
    onSubmit: (v, form) => {
      if (!tOnly && !String(v.name || '').trim()) { toast('Enter the milestone name', 'err'); return false; }
      const deps = st.deps.filter(d => d.pred).map(d => ({ pred: d.pred, type: d.type, lag: Math.round(+d.lag || 0), effect: d.effect, state: d.state }));
      if (new Set(deps.map(d => d.pred + d.type)).size < deps.length) { toast('The same predecessor and relation is listed twice', 'err'); return false; }
      const cyc = depCycle([...others.map(dItem), { ...dItem(m || {}), code: selfCode, deps }]); if (cyc) { toast(`Dependency cycle: ${cyc.join(' → ')}`, 'err'); return false; }
      const timing = { planned: v.planned || '', durationDays: Math.max(0, Math.round(+v.duration || 0)), forecastDate: v.forecast || '', deps, dependsOn: deps.map(d => d.pred), depJoin: v.depJoin === 'ANY' ? 'ANY' : 'ALL', closing: !!v.closing, damages: +v.dmgRate > 0 ? { ratePct: +v.dmgRate, capPct: +v.dmgCap > 0 ? +v.dmgCap : 10 } : null };
      if (tOnly) return ctx.onSave(timing, v.reason) === false ? false : undefined;
      const def = { name: v.name.trim(), ...timing, needsDoc: !!(m && m.needsDoc), docTitle: (m && m.needsDoc) ? (m.docTitle || 'Supporting document') : '', needsGrn: !!v.needsGrn, needsSrn: !!v.needsSrn || !!v.autoSrn, autoSrn: !!v.autoSrn, measured: !!v.measured, requireCompleteQty: !!v.requireCompleteQty,
        needsGuarantee: !!(m && m.needsGuarantee), guaranteeTitle: (m && m.needsGuarantee) ? (m.guaranteeTitle || '') : '', allowPartial: !!v.allowPartial,
        advance: { allowed: !!v.advAllowed, mode: v.advMode, value: +v.advValue || 0, recovery: v.advRec, guaranteeRequired: !!v.advGuar, guaranteeTitle: v.advGuar ? String(v.advGuarTitle || '').trim() : '' } };
      if (def.advance.allowed && !(def.advance.value > 0)) { toast('Enter the advance value', 'err'); return false; }
      if (def.advance.allowed && def.advance.guaranteeRequired && !def.advance.guaranteeTitle) { toast('Name the advance guarantee', 'err'); return false; }
      if (st.simple) { if (!(+v.pct > 0)) { toast('Enter an amount or percentage greater than zero', 'err'); return false; } Object.assign(def, { pct: +v.pct, simple: true, scope: undefined }); }
      else {
        const rows = st.rows.filter(r => r.lineId), errs = [];
        if (!rows.length) errs.push('Add at least one line to the scope.');
        if (new Set(rows.map(r => r.lineId)).size < rows.length) errs.push('A line can be listed at most once per milestone.');
        rows.forEach(r => { if (!(+r.v > 0)) errs.push('Every scope row needs a value above zero.'); });
        if (errs.length) { toast(errs[0], 'err'); return false; }
        Object.assign(def, { simple: false, scope: rows.map(r => ({ lineId: r.lineId, basis: r.basis, ...(r.basis === 'quantity' ? { qty: +r.v } : r.basis === 'percent' ? { percent: +r.v } : { amount: +r.v }) })) });
        def.needsGrn = def.needsGrn || def.scope.some(x => x.basis === 'quantity' && (lines.find(l => l.id === x.lineId) || {}).kind !== 'Services' && type !== 'Services');
      }
      if (v.trigOn) { def.trigger = { lineId: v.trigLine, qty: +v.trigQty }; const te = trigErrors(lines, { ...def, scope: def.scope }, selfCode); if (te.length) { toast(te[0].replace(/^M\d+: /, ''), 'err'); return false; } } else def.trigger = null;
      return ctx.onSave(def, v.reason) === false ? false : undefined;
    } });
  const q = s2 => ov.querySelector(s2), f = ov.querySelector('form');
  const pi = q('[name=pct]'), ai = q('[name=amount]');
  if (pi) { pi.addEventListener('input', () => { ai.value = base ? r2((+pi.value || 0) * base / 100) : ''; });
    ai.addEventListener('input', () => { pi.value = base ? parseFloat(((+ai.value || 0) / base * 100).toFixed(8)) : ''; }); }
  if (q('[name=trigOn]')) q('[name=trigOn]').addEventListener('change', e => { q('#mm-trig').style.display = e.target.checked ? '' : 'none'; });
  if (q('[name=advAllowed]')) { q('[name=advAllowed]').addEventListener('change', e => { q('#mm-adv').style.display = e.target.checked ? '' : 'none'; liveAdv(); });
    q('[name=advGuar]').addEventListener('change', e => { q('#mm-advg').style.display = e.target.checked ? '' : 'none'; }); }
  const elsewhere = (lineId, basis) => sum(others.flatMap(o => (explicitScope(o) ? o.scope : simpleScope(lines, o.pct)).filter(x => x.lineId === lineId && x.basis === basis)), x => basis === 'quantity' ? x.qty : basis === 'percent' ? x.percent : x.amount);
  const myAmount = () => sum(st.rows, r => { const l = lines.find(x => x.id === r.lineId); return l ? sliceRaw({ basis: r.basis, qty: r.v, percent: r.v, amount: r.v }, l) : 0; });
  function liveAdv() {
    const a = q('#adv-live'); if (!a) return; if (!q('[name=advAllowed]').checked) { a.textContent = ''; return; }
    const amt = st.simple ? r2((+pi.value || 0) * base / 100) : myAmount(), val = +q('[name=advValue]').value || 0, adv = q('[name=advMode]').value === 'amount' ? val : r2(amt * val / 100);
    a.textContent = amt ? `Advance = ${money(adv)} of the ${money(amt)} milestone (${fmtNum(r2(adv / amt * 100))}%).` : '';
  }
  function draw() {
    if (!q('#sc-rows')) return;
    q('#sc-simple').style.display = st.simple ? '' : 'none'; q('#sc-lines').style.display = st.simple ? 'none' : '';
    f.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'simple') === st.simple));
    q('#sc-rows').innerHTML = st.rows.map((r, i) => { const l = lines.find(x => x.id === r.lineId), el = l ? elsewhere(l.id, r.basis) : 0, tot = l ? (r.basis === 'quantity' ? l.qty : r.basis === 'percent' ? 100 : lineNet(l)) : 0, unit = r.basis === 'quantity' ? (l ? l.uom : '') : r.basis === 'percent' ? '%' : 'INR';
      return `<tr><td><select class="input sm" data-r="${i}" data-k="lineId"><option value="">Select line</option>${sched.map(x => `<option value="${x.id}" ${x.id === r.lineId ? 'selected' : ''}>${esc(lineLbl(x))}</option>`).join('')}</select></td>
        <td><select class="input sm" data-r="${i}" data-k="basis"><option value="quantity" ${r.basis === 'quantity' ? 'selected' : ''}>Quantity</option><option value="percent" ${r.basis === 'percent' ? 'selected' : ''}>% of line</option><option value="amount" ${r.basis === 'amount' ? 'selected' : ''}>Amount</option></select></td>
        <td><input class="input sm num" type="number" step="any" data-r="${i}" data-k="v" value="${esc(r.v)}" placeholder="${unit}"><div class="fhint">${l ? `${fq(Math.max(0, tot - el))} of ${fq(tot)} ${unit === '%' ? '%' : unit} free` : ''}</div></td>
        <td class="num strong">${l ? fmtNum(sliceRaw({ basis: r.basis, qty: r.v, percent: r.v, amount: r.v }, l)) : '—'}</td><td style="text-align:center"><button type="button" class="icon-btn danger" data-del="${i}" title="Remove">${icon('trash', 14)}</button></td></tr>`; }).join('') || '<tr><td class="empty" colspan="5">No lines in the scope yet</td></tr>';
    q('#sc-total').textContent = `Milestone amount = ${money(myAmount())}`;
    const rowsOk = st.rows.filter(r => r.lineId); const dup = new Set(rowsOk.map(r => r.lineId)).size < rowsOk.length;
    q('#sc-msg').innerHTML = dup ? alertBox('err', '', 'A line can be listed at most once per milestone.') : '';
    liveAdv();
  }
  /* dependencies: one row per predecessor; messages below recompute the dates, warnings and downstream impact live */
  const cur = () => ({ ...dItem(m || {}), code: selfCode, planned: q('[name=planned]').value, durationDays: Math.max(0, Math.round(+q('[name=duration]').value || 0)), forecastDate: q('[name=forecast]').value, deps: st.deps.filter(d => d.pred).map(normDep) });
  function drawDeps() {
    const used = new Set(st.deps.map(d => d.pred));
    q('#dp-rows').innerHTML = st.deps.length ? `<div class="dp-grid dp-h"><span>Predecessor</span><span>Relation</span><span>Lag (days)</span><span>Effect</span><span>When it counts</span><span></span></div>` + st.deps.map((d, i) => `<div class="dp-grid">
      <select class="input sm" data-dp="${i}" data-k="pred"><option value="">Select milestone</option>${others.map(o => `<option value="${esc(o.code)}" ${o.code === d.pred ? 'selected' : ''}>${esc(o.code)} · ${esc(o.name || '')}</option>`).join('')}${d.pred && !others.some(o => o.code === d.pred) ? `<option value="${esc(d.pred)}" selected>${esc(d.pred)} (no longer exists)</option>` : ''}</select>
      <select class="input sm" data-dp="${i}" data-k="type">${depTypeOpts.map(([k, l]) => `<option value="${k}" ${d.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input class="input sm num" type="number" step="1" data-dp="${i}" data-k="lag" value="${esc(d.lag)}" title="Negative = overlap (starts before the predecessor ends)">
      <select class="input sm" data-dp="${i}" data-k="effect">${depEffOpts.map(([k, l]) => `<option value="${k}" ${d.effect === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input sm" data-dp="${i}" data-k="state" ${d.type === 'SS' ? 'disabled' : ''}>${d.type === 'SS' ? '<option>Has started</option>' : depStateOpts.map(([k, l]) => `<option value="${k}" ${d.state === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="icon-btn danger" data-dpdel="${i}" title="Remove">${icon('trash', 14)}</button></div>`).join('') : '<div class="dp-empty">No dependencies — this milestone does not wait for any other.</div>';
    const gates = st.deps.filter(d => d.effect !== 'schedule' && d.pred).length; q('#dp-join').style.display = gates > 1 ? '' : 'none';
    liveDeps();
  }
  function liveDeps() {
    const el = q('#dp-msg'); if (!el) return; const me = cur(), after = [...others.map(dItem), me], out = [];
    const cyc = depCycle(after); if (cyc) out.push(alertBox('err', 'Dependency cycle', cyc.join(' → ') + ' — a milestone cannot (indirectly) wait for itself. Remove one of these links.'));
    if (!cyc) { depWarnings(after).filter(w => w.startsWith(selfCode + ' ') || true).forEach(w => out.push(alertBox('warn', 'Date conflict', w + ' This is a warning — it does not block saving.')));
      const d = computeDates(after)[selfCode]; if (d && (d.start || d.finish)) out.push(`<div class="dp-sum"><span>Planned <b>${d.plannedStart ? fmtD(d.plannedStart) : '—'}</b> → <b>${d.plannedFinish ? fmtD(d.plannedFinish) : '—'}</b></span>${d.slip ? `<span class="tl-chip ${d.slip > 0 ? 'late' : 'early'}">Forecast ${fmtD(d.finish)} · ${d.slip > 0 ? '+' : ''}${d.slip}d</span>` : ''}${d.driver ? `<span class="hint">driven by ${d.driver}</span>` : ''}</div>`);
      if (m) { const imp = depImpact([...others, m].map(dItem), after, ctx.po).filter(r => r.code !== selfCode);
        if (imp.length) out.push(alertBox('info', `Impact on ${imp.length} dependent milestone${imp.length > 1 ? 's' : ''}`, imp.map(r => r.frozen ? `${r.code} is already invoiced — its dates stay as they are.` : `${r.code}: forecast ${fmtD(r.from)} → <b>${fmtD(r.to)}</b> (${r.days > 0 ? '+' : ''}${r.days} days)`).join('<br>'))); } }
    el.innerHTML = out.join('');
  }
  f.addEventListener('click', e => { const md = e.target.closest('[data-mode]'); if (md && !md.disabled) { st.simple = md.dataset.mode === 'simple'; draw(); }
    if (e.target.closest('#sc-add')) { const used = new Set(st.rows.map(r => r.lineId)), nl = sched.find(l => !used.has(l.id)); st.rows.push({ lineId: nl ? nl.id : '', basis: 'quantity', v: '' }); draw(); }
    if (e.target.closest('#dp-add')) { const used = new Set(st.deps.map(d => d.pred)), np = others.find(o => !used.has(o.code)) || others[0]; st.deps.push({ pred: np ? np.code : '', type: 'FS', lag: 0, effect: 'schedule', state: 'approved' }); drawDeps(); }
    const dd = e.target.closest('[data-dpdel]'); if (dd) { st.deps.splice(+dd.dataset.dpdel, 1); drawDeps(); }
    const dl = e.target.closest('[data-del]'); if (dl) { st.rows.splice(+dl.dataset.del, 1); draw(); } });
  f.addEventListener('change', e => { const t = e.target;
    if (t.dataset.r != null) { const r = st.rows[+t.dataset.r]; r[t.dataset.k] = t.value; if (t.dataset.k === 'basis') r.v = ''; draw(); }
    if (t.dataset.dp != null) { st.deps[+t.dataset.dp][t.dataset.k] = t.dataset.k === 'lag' ? Math.round(+t.value || 0) : t.value; drawDeps(); }
    if (t.name === 'advMode') liveAdv(); if (['planned', 'duration', 'forecast'].includes(t.name)) liveDeps(); });
  f.addEventListener('input', e => { const t = e.target;
    if (t.dataset.r != null && t.dataset.k === 'v') { st.rows[+t.dataset.r].v = t.value; q('#sc-total').textContent = `Milestone amount = ${money(myAmount())}`; const l = lines.find(x => x.id === st.rows[+t.dataset.r].lineId); const td = t.closest('tr').children[3]; if (l) td.textContent = fmtNum(sliceRaw({ basis: st.rows[+t.dataset.r].basis, qty: t.value, percent: t.value, amount: t.value }, l)); liveAdv(); }
    if (t.dataset.dp != null && t.dataset.k === 'lag') { st.deps[+t.dataset.dp].lag = Math.round(+t.value || 0); liveDeps(); }
    if (['planned', 'duration', 'forecast'].includes(t.name)) liveDeps();
    if (t.name === 'advValue' || t.name === 'pct' || t.name === 'amount') liveAdv(); });
  draw(); drawDeps();
}
function openMsModal(idx) {
  const f = ui.f, edit = idx != null, m = edit ? f.milestones[idx] : null;
  openMsEditor({ lines: f.lines, type: f.type, milestones: f.milestones.map((x, i) => ({ ...x, code: 'M' + (i + 1) })), m: m && { ...m, code: 'M' + (idx + 1) }, title: edit ? `Edit milestone M${idx + 1}` : 'Add Milestone', submitLabel: edit ? 'Save' : 'Add',
    onSave: def => { const n = { ...(edit ? m : {}), ...def }; if (def.simple) { delete n.scope; } if (edit) f.milestones[idx] = n; else f.milestones.push(n); render(); } });
}
/* amendment mode: re-assign scope / gates / advance terms of a milestone that has not been submitted */
ACT['ms-amend'] = el => {
  const m = getMS(el.dataset.id), po = getPO(m.poId); if (msLocked(m)) return toast(`${m.code} is ${usage('milestone', m.id).value > EPS ? 'invoiced' : m.status.toLowerCase()} — its scope and gates are locked.`, 'err');
  openMsEditor({ lines: po.lines, type: po.type, milestones: msOf(po), m, po, amend: true, title: `Amend ${m.code} — scope, conditions & timing`, submitLabel: 'Apply amendment',
    onSave: (def, reason) => { const patch = { name: def.name, measured: def.measured, trigger: def.trigger, damages: def.damages, planned: def.planned, durationDays: def.durationDays, forecastDate: def.forecastDate, deps: def.deps, depJoin: def.depJoin, closing: def.closing, scope: def.scope, needsDoc: def.needsDoc, docTitle: def.docTitle, needsGrn: def.needsGrn, needsSrn: def.needsSrn, autoSrn: def.autoSrn, requireCompleteQty: def.requireCompleteQty, needsGuarantee: def.needsGuarantee, guaranteeTitle: def.guaranteeTitle, allowPartial: def.allowPartial };
      if (!advOfMs(m).some(a => !a.rejected)) patch.advance = def.advance;
      const r = A.amendMilestone(po.id, m.id, patch, reason); if (!r.ok) { errorModal(r.msg, r.errors || [r.msg]); return false; } toast(r.msg); closePanel(); render(); } });
};
ACT['ms-amend-add'] = el => {
  const po = getPO(el.dataset.po); document.querySelector('.overlay')?.remove();
  openMsEditor({ lines: po.lines, type: po.type, milestones: msOf(po), m: null, po, nextSeq: Math.max(0, ...msOf(po).map(q => q.seq)) + 1, amend: true, title: 'Add milestone by amendment', submitLabel: 'Add milestone',
    onSave: (def, reason) => { const r = A.amendAddMilestone(po.id, def, reason); if (!r.ok) { errorModal(r.msg, r.errors || [r.msg]); return false; } toast(r.msg); render(); } });
};
ACT['ms-edit'] = el => openMsModal(+el.dataset.i);
/* timing & dependencies only — allowed on a submitted / approved milestone; frozen once it has been invoiced (D20) */
ACT['ms-timing'] = el => {
  const m = getMS(el.dataset.id), po = getPO(m.poId); if (usage('milestone', m.id).value > EPS) return toast(`${m.code} is already invoiced — its dates and dependencies are frozen.`, 'err');
  openMsEditor({ lines: po.lines, type: po.type, milestones: msOf(po), m, po, amend: true, timingOnly: true, title: `Timing & dependencies — ${m.code}`, submitLabel: 'Apply change',
    onSave: (def, reason) => { const r = A.amendMilestone(po.id, m.id, { planned: def.planned, durationDays: def.durationDays, forecastDate: def.forecastDate, deps: def.deps, depJoin: def.depJoin, closing: def.closing, damages: def.damages }, reason); if (!r.ok) { errorModal(r.msg, r.errors || [r.msg]); return false; } toast(r.msg); closePanel(); render(); } });
};
function poPanelFoot() { return `<button class="btn btn-ghost" data-act="po-save">Save as Draft</button><button class="btn btn-dark" data-act="po-submit">Create Order</button>`; }
function poDerive() {
  const f = ui.f; if (!f) return;
  const v = fVal(f), gst = r2(v * (+f.gstRate || 0) / 100);
  f.lines.forEach((l, i) => { const e = $('#li-amt-' + i); if (e) e.textContent = fmtNum(r2((+l.qty || 0) * (+l.price || 0) * (1 + (+f.gstRate || 0) / 100))); });
  const t = $('#li-total'); if (t) t.innerHTML = `<span>Base amount <b>${money(v)}</b></span><span>GST ${f.gstRate}% <b>${money(gst)}</b></span><span>Total <b>${money(r2(v + gst))}</b></span>`;
  if (f.billingMethod === 'Milestone') {
    const sv = schedView(f), amts = sv.amounts, base = sv.base;
    f.milestones.forEach((m, i) => { const e = $('#ms-amt-' + i); if (e) e.innerHTML = `${fmtNum(amts[i] || 0)}`; const pe = $('#ms-pct-' + i); if (pe) pe.textContent = `${fmtNum(base ? r2((amts[i] || 0) / base * 100) : 0)}%`; });
    const tot = sv.pctTotal, segs = f.milestones.map((m, i) => { const pc = base ? (amts[i] || 0) / base * 100 : 0; return `<span title="M${i + 1}" style="width:${Math.max(0, Math.min(100, pc)).toFixed(2)}%;background:${MS_COLORS[i % MS_COLORS.length]}">${pc >= 9 ? `M${i + 1} · ${fmtNum(r2(pc))}%` : ''}</span>`; }).join('');
    const bar = $('#ms-bar'); if (bar) bar.innerHTML = `<div class="alloc-bar ${tot > 100.0001 ? 'over' : ''}">${segs}</div><div class="alloc-meta"><span>${fmtNum(tot)}% of ${money(base)} scheduled</span><span class="${Math.abs(tot - 100) < 0.0001 ? 'ok-t' : tot > 100 ? 'bad-t' : 'warn-t'}">${Math.abs(tot - 100) < 0.0001 ? 'fully allocated' : tot > 100 ? `${fmtNum(r2(tot - 100))}% over` : `${fmtNum(r2(100 - tot))}% unallocated`}</span></div>`;
    const cv = $('#ms-cov'); if (cv) cv.innerHTML = sv.explicit || f.lines.some(isOutside) ? `<div class="tbl-wrap" style="margin-top:8px"><table class="tbl sm"><thead><tr><th>Line</th><th>Basis</th><th class="right">Assigned</th><th class="right">Line total</th><th>Coverage</th></tr></thead><tbody>${f.lines.map((l, i) => { const c = sv.coverage.find(x => x.lineId === l.id); if (isOutside(l)) return `<tr class="dim"><td>L${i + 1} ${esc(l.desc)}</td><td>—</td><td class="num">—</td><td class="num">${fmtNum(l.qty)} ${esc(l.uom)}</td><td><span class="badge-s s-gray">Billed outside the schedule</span></td></tr>`; if (!c) return `<tr><td>L${i + 1} ${esc(l.desc)}</td><td>—</td><td class="num">0</td><td class="num">${fmtNum(l.qty)} ${esc(l.uom)}</td><td><span class="badge-s s-red">Not assigned</span></td></tr>`; const ok = Math.abs(c.diff) < 0.005; return `<tr><td>L${i + 1} ${esc(l.desc)}</td><td>${c.basis ? BASIS_LABEL[c.basis] : '—'}</td><td class="num">${fq(c.assigned)} ${c.unit === '%' ? '%' : esc(c.unit)}</td><td class="num">${fq(c.total)} ${c.unit === '%' ? '%' : esc(c.unit)}</td><td>${ok ? '<span class="badge-s s-green">Fully assigned</span>' : `<span class="badge-s s-${c.diff > 0 ? 'amber' : 'red'}">${c.diff > 0 ? fq(c.diff) + ' left' : fq(-c.diff) + ' over'}</span>`}</td></tr>`; }).join('')}</tbody></table></div>` : '';
    const s2 = $('#ms-sum'); if (s2) { const dl = f.milestones.map((m, i) => ({ ...m, code: 'M' + (i + 1) })), cyc = depCycle(dl), dw = cyc ? [] : depWarnings(dl);
      s2.innerHTML = (f.milestones.length && !sv.ok ? alertBox('warn', 'The schedule is not valid yet', errList(sv.errors)) : '') + (cyc ? alertBox('err', 'Dependency cycle', cyc.join(' → ')) : '') + (dw.length ? alertBox('warn', 'Date conflicts (warning only)', errList(dw)) : ''); }
  }
}
ACT['ln-add'] = () => { ui.f.lines.push(blankLine()); render(); };
ACT['ln-del'] = el => { ui.f.lines.splice(+el.dataset.i, 1); render(); };
ACT['po-method'] = el => { const f = ui.f; f.billingMethod = el.dataset.m; if (f.billingMethod === 'Milestone' && !f.milestones.length) f.milestones = EXAMPLE_SCHEDULE(f); render(); };
ACT['po-basis'] = el => { ui.f.progressBasis = el.dataset.b; render(); };
ACT['ms-add'] = () => openMsModal(null);
ACT['ms-del'] = el => { const i = +el.dataset.i, gone = 'M' + (i + 1), ren = c => { const n = +String(c).slice(1); return n > i + 1 ? 'M' + (n - 1) : c; };
  ui.f.milestones.splice(i, 1);
  ui.f.milestones.forEach(m => { const rm = ds => (ds || []).filter(d => (d.pred || d) !== gone); if (Array.isArray(m.deps)) m.deps = rm(m.deps).map(d => ({ ...d, pred: ren(d.pred) })); if (m.dependsOn) m.dependsOn = rm(m.dependsOn).map(ren); });
  render(); };
ACT['ms-example'] = () => { ui.f.milestones = EXAMPLE_SCHEDULE(ui.f); render(); };
ACT['po-save'] = () => done(A.savePO(ui.f, false), r => { closePanel(); go(`#/po/${r.id}`); });
ACT['po-submit'] = () => done(A.savePO(ui.f, true), r => { closePanel(); go(`#/po/${r.id}`); });

/* ---------------------------------------------------------------- detail */
function billTabName(po) { return po.billingMethod === 'Milestone' ? 'Milestones' : poCertified(po) ? 'Progress Claims' : 'Billing'; }
function poDetail(po, r) {
  const tab = r.q.tab || 'overview', s = poSummary(po), st = poStage(po);
  const actions = [];
  if (po.status === 'Draft') actions.push(gbtn('po.edit', 'po-edit', 'Edit', { data: { id: po.id }, icn: 'edit', cls: 'btn-outline' }), gbtn('po.edit', 'po-submit-draft', 'Submit for Approval', { cls: 'btn-soft', data: { id: po.id }, icn: 'check' }));
  if (po.status === 'Pending Approval') actions.push(gbtn('po.edit', 'po-reopen', 'Return to draft', { data: { id: po.id }, cls: 'btn-ghost' }), gbtn('po.approve', 'po-reject', 'Reject', { cls: 'btn-danger', data: { id: po.id } }), gbtn('po.approve', 'po-approve', 'Approve', { cls: 'btn-soft', data: { id: po.id }, icn: 'check' }));
  if (po.status === 'Rejected') actions.push(gbtn('po.edit', 'po-reopen', 'Revise PO', { cls: 'btn-soft', data: { id: po.id }, icn: 'edit' }));
  if (po.status === 'Approved') actions.push(gbtn('po.amend', 'po-amend', 'Amend PO', { data: { id: po.id }, icn: 'edit', cls: 'btn-outline' }));
  const nRec = (hasGoods(po) ? grnsOf(po).length : 0) + (hasServices(po) ? srnsOf(po).length : 0);
  const tabs = [['overview', 'Overview'], ['lines', 'Line Items'], ['billing', billTabName(po)], ['receipts', recLabel(po)], ['invoices', 'Invoice'], ...(po.billingMethod === 'Milestone' ? [['advances', 'Advances']] : []), ['history', 'History']];
  const body = { overview: poOverview, lines: poLinesTab, billing: poBillingTab, receipts: poReceiptsTab, invoices: poInvoicesTab, advances: po => poAdvancesTab(po), history: poHistoryTab }[tab] || poOverview;
  const dots = st.steps.map((_, i) => `<i class="${st.reached[i] ? 'on' : ''} ${i === st.cur && !st.complete ? 'cur' : ''}">${st.reached[i] ? icon('check', 8, 4) : ''}</i>`).join('');
  return `<div class="page po-detail"><div class="ph"><button class="back" data-act="back" title="Back">${icon('back', 18, 2)}</button><div class="po-ttl"><h1>${esc(po.number)}</h1><div class="tags">${poMethodBadge(po)} ${typeBadge(po)}</div></div><div class="right">${actions.join('')}</div></div>
  <div class="stage-row"><div class="stage ${st.tone === 'green' ? '' : st.tone}"><div class="ico">${icon(po.type === 'Goods' ? 'box' : po.type === 'Services' ? 'truck' : 'layers', 24, 1.8)}</div>
    <div class="grow"><div class="t">${esc(st.label)}</div><div class="chips"><span class="chip">Stage ${Math.min(st.cur + 1, 6)}/6</span><span class="chip">${esc(getSup(po.supplierId).name)} · Vendor</span>${po.status !== 'Rejected' && !st.complete ? `<span class="chip">${esc(st.next)}</span>` : ''}</div></div>
    <div class="dots">${dots}</div><div class="pct">${st.pctDone}%</div>${po.status === 'Approved' && !st.complete ? '<span class="live">LIVE</span>' : ''}</div>
    <button class="side-tg" data-act="po-side" title="${ui.poSideOff ? 'Show' : 'Hide'} side panel">${icon(ui.poSideOff ? 'chevLeft' : 'chevRight', 14, 2.2)}</button></div>
  ${tabsHtml(tabs, tab, `#/po/${po.id}`)}
  ${po.scheduleOpen ? `<div style="margin-top:16px">${alertBox('warn', 'Milestone schedule reopened', `A PO amendment left part of a line unassigned (or over-assigned). Assign the difference with <b>Edit scope &amp; gates</b> on a milestone, or <b>Add milestone</b>.${errList(po.scheduleOpen)}`)}</div>` : ''}
  <div>${body(po, s)}</div></div>`;
}
ACT['po-side'] = () => { ui.poSideOff = !ui.poSideOff; render(); };
ACT['po-submit-draft'] = el => done(A.savePO(poDraftExisting(getPO(el.dataset.id)), true));
ACT['po-approve'] = el => confirmBox({ title: 'Approve purchase order', message: `Approve <b>${esc(getPO(el.dataset.id).number)}</b>? It becomes available for ${recName(getPO(el.dataset.id))}${getPO(el.dataset.id).billingMethod === 'Milestone' ? ' and milestone work' : ''} and invoice selection.`, confirmLabel: 'Approve', onConfirm: () => done(A.approvePO(el.dataset.id)) });
ACT['po-reject'] = el => reasonModal({ title: 'Reject purchase order', label: 'Rejection reason', btn: 'Reject PO', onSubmit: reason => { done(A.rejectPO(el.dataset.id, reason)); } });
ACT['po-reopen'] = el => done(A.reopenPO(el.dataset.id));

/* what the user can do next on this PO */
function nextSteps(po, s) {
  const out = [];
  if (po.status === 'Draft') out.push(['Submit the PO for approval.', gbtn('po.edit', 'po-submit-draft', 'Submit for Approval', { cls: 'btn-primary btn-sm', data: { id: po.id } })]);
  else if (po.status === 'Pending Approval') out.push(['Waiting for the Procurement Manager.', gbtn('po.approve', 'po-approve', 'Approve', { cls: 'btn-primary btn-sm', data: { id: po.id } })]);
  else if (po.status === 'Rejected') out.push(['The PO was rejected — revise and resubmit.', gbtn('po.edit', 'po-reopen', 'Revise PO', { cls: 'btn-primary btn-sm', data: { id: po.id } })]);
  else if (po.status === 'Approved') {
    if (po.billingMethod === 'Milestone') msOf(po).forEach(m => {
      const g = msGate(m, po), open = (label, cls = 'btn-outline btn-xs') => actBtn('ms-open', label, { data: { id: m.id }, cls });
      if (m.status === 'Pending') out.push([`${m.code} ${esc(m.name)} — work not started${m.needsDoc ? `; the supplier must upload the ${esc(docTitleOf(m))}` : ''}.`, open('Open')]);
      else if (m.status === 'In Progress') out.push([`${m.code} ${esc(m.name)} — in progress; submit it with its evidence${m.needsDoc ? ` (${esc(docTitleOf(m))} is mandatory)` : ''}.`, open('Submit', 'btn-primary btn-xs')]);
      else if (m.status === 'Submitted for Approval') out.push([`${m.code} ${esc(m.name)} — submitted, waiting for the approver.`, open('Review', 'btn-primary btn-xs')]);
      else if (m.status === 'Under Review') out.push([`${m.code} ${esc(m.name)} — under review.`, open('Decide', 'btn-primary btn-xs')]);
      else if (m.status === 'Rejected') out.push([`${m.code} ${esc(m.name)} — rejected (${esc(m.rejectReason)}); the supplier must resubmit.`, open('Open')]);
      else if (m.status === 'Approved' && !g.ok) out.push([`${m.code} approved — invoicing blocked: ${esc(g.reason)}.`, open('Open')]);
      else if (msEnt(m, po) > 0 && usage('milestone', m.id).value < m.amount - EPS) out.push([`${m.code} ${esc(m.name)} — approved and cleared, ${money(m.amount - usage('milestone', m.id).value)} ready to invoice.`, gbtn('inv.create', 'inv-new', 'Submit Invoice', { cls: 'btn-primary btn-xs', data: { po: po.id, ms: m.id } })]);
    });
    else if (poCertified(po)) {
      if (claimsOf(po).some(c => c.status === 'Submitted')) out.push(['A progress claim is awaiting certification.', actBtn('go', 'Review', { data: { hash: `#/po/${po.id}?tab=billing` }, cls: 'btn-primary btn-xs' })]);
      else out.push(['Vendor raises the next progress claim.', gbtn('claim.create', 'claim-new', 'New claim', { cls: 'btn-outline btn-xs', data: { po: po.id } })]);
      if (s.remaining > EPS) out.push([`${money(s.remaining)} of certified progress is ready to invoice.`, gbtn('inv.create', 'inv-new', 'Submit Invoice', { cls: 'btn-primary btn-xs', data: { po: po.id } })]);
    } else {
      if (hasGoods(po) && s.remainingPOQty > EPS) out.push([`${fmtNum(s.remainingPOQty)} units are still to be received.`, gbtn('grn.create', 'grn-new', 'Create GRN', { cls: 'btn-outline btn-xs', data: { po: po.id } })]);
      if (hasServices(po) && sum(serviceLines(po), l => lineServiceStats(po, l).remaining) > EPS) out.push(['Service value is still to be received.', gbtn('srn.create', 'srn-new', 'Create SRN', { cls: 'btn-outline btn-xs', data: { po: po.id } })]);
      const pend = [...(hasGoods(po) ? grnsOf(po).filter(g => g.status === 'Pending Inspection') : []), ...(hasServices(po) ? srnsOf(po).filter(x => x.status === 'Pending Acceptance') : [])];
      if (pend.length) out.push([`${pend.length} receipt${pend.length > 1 ? 's' : ''} awaiting inspection / acceptance — not invoice-eligible yet.`, actBtn('go', 'Open', { data: { hash: `#/po/${po.id}?tab=receipts` }, cls: 'btn-outline btn-xs' })]);
      if (s.remaining > EPS) out.push([`${money(s.remaining)} is accepted and ready to invoice.`, gbtn('inv.create', 'inv-new', 'Submit Invoice', { cls: 'btn-primary btn-xs', data: { po: po.id } })]);
    }
  }
  return out;
}
function poOverview(po, s) {
  const total = s.value || 1, w = x => pct(x, total).toFixed(2), off = officeOf(po.office), sup = getSup(po.supplierId);
  const paid = s.paid, apprOnly = r2(s.approved - s.paid), res = s.reserved, avail = s.remaining;
  const log = db.audit.filter(a => a.poId === po.id).slice(0, 7), next = nextSteps(po, s);
  const basis = po.billingMethod === 'Progressive' ? (poCertified(po) ? 'Certified work progress' : `Accepted ${recName(po)}s`) : po.billingMethod === 'Milestone' ? `${msOf(po).length} milestones` : `Accepted ${recName(po)}s, PO level`;
  return `<div class="main-grid ${ui.poSideOff ? 'side-off' : ''}"><div>
    <div class="ov-top"><h2>Overview</h2><span class="spacer"></span>${actBtn('po-view', 'View Purchase Order', { cls: 'btn-primary', data: { id: po.id } })}</div>
    <div class="stat-row"><div class="stat green"><b>${esc(po.status)}</b><span>Status</span></div><div class="stat peach"><b>${esc(po.createdBy)}</b><span>Raised By</span></div><div class="stat pink"><b>${esc(po.category)}</b><span>Category</span></div><div class="stat gray"><b>${money(s.value)}</b><span>Amount (excl. GST)</span></div></div>
    <div class="meta-row"><div><div class="k">PO Title</div><div class="v">${esc(po.title)}</div></div><div><div class="k">Creation Date</div><div class="v">${fmtD(po.poDate)}</div></div><div><div class="k">Delivery Date</div><div class="v">${fmtD(po.deliveryDate)}</div></div><div><div class="k">End Date</div><div class="v">${fmtD(po.endDate)}</div></div></div>
    <div class="cards-3" style="margin-top:22px">
      <div class="card"><div class="card-t">Supplier Details</div><div class="strong" style="margin-bottom:8px">${esc(sup.name)}</div><div class="dl"><span class="k">Email</span><span>${esc(sup.email)}</span><span class="k">Mobile</span><span>${esc(sup.mobile)}</span><span class="k">GSTIN</span><span>${esc(sup.gstin)}</span></div></div>
      <div class="card"><div class="card-t">Billing Details</div><div class="strong" style="margin-bottom:8px">${esc(off.name)}</div><div class="dl"><span class="k">Address</span><span>${esc(off.address)}</span><span class="k">GSTIN</span><span>${esc(off.gstin)}</span></div></div>
      <div class="card"><div class="card-t">Billing Setup</div><div style="margin-bottom:10px">${poMethodBadge(po)}</div><div class="dl"><span class="k">Based on</span><span>${esc(basis)}</span><span class="k">GST</span><span>${gstOf(po)}%</span><span class="k">Receipt</span><span>${recName(po)} (${po.type.toLowerCase()})</span></div></div>
    </div>
    <div class="sec">Billing summary</div>
    ${strip([['PO value', money(s.value), 'excl. GST'], ['Accepted', money(s.accepted), po.billingMethod === 'Milestone' ? 'approved milestones' : poCertified(po) ? 'certified' : `accepted ${recName(po)}s`], ['Invoiced', money(s.invoiced), `in flight: ${money(s.reserved)}`], ['Approved', money(s.approved), 'approved · posted · paid'], ['Paid', money(s.paid), 'demo payments'], ...(advsOf(po).length ? [['Advance outstanding', money(s.advanceOutstanding), 'unrecovered · counts on the PO ceiling']] : []), ['Ready to invoice', money(s.remaining), 'accepted − invoiced', 'hl']])}
    <div class="card flat" style="margin-top:14px"><div class="bar"><span class="b-paid" style="width:${w(paid)}%"></span><span class="b-appr" style="width:${w(apprOnly)}%"></span><span class="b-res" style="width:${w(res)}%"></span><span class="b-avail" style="width:${w(avail)}%"></span></div>
      <div class="legend"><span><i style="background:#1F9D63"></i>Paid ${money(paid)}</span><span><i style="background:#7BC79B"></i>Approved, unpaid ${money(apprOnly)}</span><span><i style="background:#F0B24A"></i>Invoiced, in approval ${money(res)}</span><span><i style="background:var(--primary)"></i>Ready to invoice ${money(avail)}</span><span><i style="background:#E9E9F0"></i>Not yet accepted ${money(Math.max(0, r2(s.value - paid - apprOnly - res - avail)))}</span></div></div>
    ${hasGoods(po) ? `<div class="sec">Goods quantities</div>${strip([['Ordered', fmtNum(sum(goodsLines(po), l => l.qty)) + ' units'], ['Delivered', fmtNum(s.receivedQty) + ' units'], ['Accepted', fmtNum(s.acceptedQty) + ' units'], ['Rejected', fmtNum(s.rejectedQty) + ' units', 'not invoice-eligible'], ['Still to receive', fmtNum(s.remainingPOQty) + ' units', '', 'hl']])}` : ''}
    <div class="sec">Line Items</div>${lineTable(po)}
    <div class="ov-sec"><div class="ov-h">${esc(billTabName(po))}</div>${poBillingTab(po, s)}</div>
    <div class="ov-sec"><div class="ov-h">${recLabel(po)}</div>${rcTab(po, true)}</div>
    <div class="ov-sec"><div class="ov-h">Invoices</div>${poInvoicesTab(po)}</div>
    ${po.billingMethod === 'Milestone' ? `<div class="ov-sec"><div class="ov-h">Advances</div>${poAdvancesTab(po)}</div>` : ''}
    <div class="ov-sec"><div class="ov-h">History</div>${poHistoryTab(po)}</div>
  </div>
  <div>
    <div class="side-card"><h4>What's next</h4>${next.length ? next.map(([t, b]) => `<div class="attn"><div style="flex:1;line-height:1.45">${t}</div>${b}</div>`).join('') : `<div class="hint">${po.status === 'Approved' ? 'Nothing is waiting on you for this PO right now.' : 'No action available.'}</div>`}</div>
    <div class="side-card"><h4 style="display:flex;align-items:center;gap:10px">Timeline<span class="spacer" style="flex:1"></span></h4>
      <div class="row" style="margin-bottom:14px"><span class="tat">Overall TAT: ${tatOf(po)}</span><span class="spacer"></span><button class="btn-orange" data-act="po-export" data-id="${po.id}">${icon('download', 14, 2)}Export</button></div>
      ${tlItems(po).join('') || '<div class="hint">No activity yet.</div>'}
      <div style="text-align:right"><button class="link" style="font-size:12px" data-act="go" data-hash="#/po/${po.id}?tab=history">View full history</button></div></div>
    <div class="side-card"><h4>Delegate Access</h4><div class="boxline"><button class="btn-dk" data-act="stub" data-name="Forward Request">+ Forward Request</button></div></div>
    <div class="side-card"><h4>Multiple Email</h4><div class="boxline">No Email Tagged</div></div>
    <div class="side-card"><h4>Support Ticket</h4><div class="boxline"><button class="btn-dk" data-act="stub" data-name="Support conversation">+ Start Conversation</button></div></div>
    <div class="side-card"><h4>PO copy send to vendor</h4><div class="boxline"><div class="row"><span class="pill red" style="font-size:10px;border-radius:5px">PDF</span></div><button class="btn-dk" style="margin-top:10px" data-act="po-send" data-id="${po.id}">Send Copy</button></div></div>
    <div class="side-card"><h4>Contract List</h4><div class="hint" style="text-align:center;padding:10px">No contract found</div></div>
  </div></div>`;
}
/* PO line table — shared by Overview and Line Items */
function lineTable(po) {
  return `<div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Details</th>${po.type === 'Mixed' ? '<th>Type</th>' : ''}<th>Delivery Address</th><th class="right">Qty / Unit</th><th class="right">Price / Unit</th><th class="right">Delivered</th><th class="right">Accepted</th><th class="right">Balance</th><th class="right">GST</th><th class="right">Amount</th></tr></thead><tbody>
  ${po.lines.map(l => { const g = lineKind(po, l) === 'Goods', st = g ? lineReceiptStats(po, l) : lineServiceStats(po, l), ss = srnsOf(po).filter(x => x.lineId === l.id);
    return `<tr><td class="strong">${esc(l.desc)}<div class="sub" style="font-weight:400">Line ${l.no}</div></td>${po.type === 'Mixed' ? `<td><span class="t-badge ${g ? '' : 't-services'}">${g ? 'Goods' : 'Service'}</span></td>` : ''}<td>${esc(officeOf(po.office).name)}</td><td class="num">${fmtNum(l.qty)} ${esc(l.uom)}</td><td class="num">${money(l.price)} / ${esc(l.uom)}</td>
      <td class="num">${g ? fmtNum(st.receivedQty) : money(sum(ss.filter(x => x.status !== 'Rejected'), x => x.serviceValue))}</td><td class="num">${g ? fmtNum(st.acceptedQty) : money(st.accepted)}</td><td class="num strong">${g ? fmtNum(st.remaining) : money(st.remaining)}</td><td class="num">${gstOf(po)}%</td><td class="num strong">${money(lineNet(l))}</td></tr>`; }).join('')}
  <tr class="total"><td colspan="${po.type === 'Mixed' ? 9 : 8}" class="right">Total (excl. GST)</td><td class="num">${money(poNet(po))}</td></tr></tbody></table></div>`;
}
const poLinesTab = po => `<div style="margin-top:22px">${lineTable(po)}</div><p class="hint" style="margin-top:10px">GST (${gstOf(po)}%) is added on invoices: ${money(r2(poNet(po) * gstOf(po) / 100))} on the full PO value, ${money(poValueGross(po))} in total.</p>`;

function poBillingTab(po, s) {
  if (po.billingMethod === 'Milestone') return milestoneTable(po, s);
  if (poCertified(po)) return claimsBlock(po, s);
  return receiptEntitlementTable(po, s, po.billingMethod === 'Progressive');
}
function poReceiptsTab(po) { return rcTab(po); }
function poInvoicesTab(po) {
  const invs = invsOf(po);
  return `<div class="sec" style="margin-top:22px">Invoices${po.status === 'Approved' ? `<button class="plus-circle" data-act="inv-new" data-po="${po.id}" title="Submit Invoice">${icon('plus', 18, 2.4)}</button>` : ''}</div>
  ${invs.length ? `<div class="inv-cards">${invs.map(i => `<div class="inv-card" data-act="inv-view" data-id="${i.id}"><div class="inv-thumb"><i></i><i></i><i></i></div>
    <div class="inv-ref">${invRef(i)}</div><div class="inv-amt">INR ${fmtNum(i.gross)}</div>
    <div class="inv-meta"><div>Vendor: ${esc(getSup(po.supplierId).name)}</div><div>Owner: ${esc(i.createdBy || po.createdBy)}</div><div>Date: ${fmtD(i.date)}</div><div>Bill No.: ${esc(i.number)}</div><div>Against: ${esc(i.allocs.map(allocRefLabel).join(', ') || 'PO level')}</div></div>
    <div class="inv-foot">${sb(i.status)}${i.match ? sb(i.match.result) : ''}</div></div>`).join('')}</div>`
    : `<div class="po-empty">${icon('box', 22, 1.6)}<span>No Invoice Submitted yet</span></div>`}`;
}
function poHistoryTab(po) {
  const log = db.audit.filter(a => a.poId === po.id);
  return `<div class="cards-2" style="margin-top:22px;align-items:start"><div class="timeline-card"><div class="card-t">Approvals</div><ul class="tl">${po.approvals.map(a => `<li class="${a.action === 'Approved' ? 'ok' : a.action === 'Rejected' ? 'bad' : ''}"><div class="tt">${esc(a.action)}</div><div class="tm">${esc(a.by)} · ${fmtDT(a.at)}${a.note ? ' — ' + esc(a.note) : ''}</div></li>`).join('') || '<li><div class="tm">No approval activity yet.</div></li>'}</ul>
    <div class="card-t" style="margin-top:14px">Amendments</div><ul class="tl">${po.amendments.map(a => `<li class="amber"><div class="tt">v${a.version} — ${money(a.valueBefore)} → ${money(a.valueAfter)}</div><div class="tm">${esc(a.by)} · ${fmtDT(a.at)} · ${esc(a.reason)}</div><div class="hint">${esc(a.changes.join('; ') || 'No value change')}</div></li>`).join('') || '<li><div class="tm">No amendments.</div></li>'}</ul></div>
  <div class="timeline-card"><div class="card-t">Audit trail</div><ul class="tl">${log.map(a => `<li class="${a.kind === 'ok' ? 'ok' : a.kind === 'bad' ? 'bad' : a.kind === 'alloc' ? 'amber' : ''}"><div class="tt">${esc(a.text)}</div><div class="tm">${esc(a.ref)} · ${esc(a.by)} · ${fmtDT(a.at)}</div></li>`).join('') || '<li><div class="tm">No activity.</div></li>'}</ul></div></div>`;
}

/* ----- View Purchase Order (document preview) ----- */
ACT['po-view'] = el => {
  const po = getPO(el.dataset.id);
  openPanel({ key: 'po-view', mid: true, title: po.number, sub: `${esc(po.title)} · ${fmtD(po.poDate)}`, body: () => { const sup = getSup(po.supplierId), off = officeOf(po.office), net = poNet(po), gst = r2(net * gstOf(po) / 100);
    return `<div class="doc"><h3>PURCHASE ORDER</h3>
    <div class="box"><div><b>Vendor</b>${esc(sup.name)}<br>${esc(sup.email)}<br>GSTIN ${esc(sup.gstin)}</div><div class="r"><b>PO Number</b>${esc(po.number)}<br>Date ${fmtD(po.poDate)}<br>Delivery by ${fmtD(po.deliveryDate)}</div>
      <div><b>Bill to</b>${esc(off.name)}<br>${esc(off.address)}<br>GSTIN ${off.gstin}</div><div class="r"><b>Billing method</b>${esc(methodLabel(po))}<br>Type ${esc(po.type)}<br>Version v${po.version}</div></div>
    <table><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">GST</th><th class="r">Amount</th></tr></thead><tbody>${po.lines.map(l => `<tr><td>${l.no}</td><td>${esc(l.desc)}</td><td class="r">${fmtNum(l.qty)} ${esc(l.uom)}</td><td class="r">${fmtNum(l.price)}</td><td class="r">${gstOf(po)}%</td><td class="r">${fmtNum(lineNet(l))}</td></tr>`).join('')}</tbody></table>
    <div class="totals"><div><span>Base amount</span><span>${fmtNum(net)}</span></div><div><span>GST ${gstOf(po)}%</span><span>${fmtNum(gst)}</span></div><div class="g"><span>Total (INR)</span><span>${fmtNum(r2(net + gst))}</span></div></div>
    ${po.billingMethod === 'Milestone' ? `<div class="sec-h">Payment milestones</div><table><thead><tr><th>#</th><th>Milestone</th><th class="r">%</th><th class="r">Amount</th></tr></thead><tbody>${msOf(po).map(m => `<tr><td>${m.code}</td><td>${esc(m.name)}<div class="muted" style="font-size:11px">${[m.needsDoc ? esc(docTitleOf(m)) + ' approved' : '', m.needsGrn ? 'accepted GRN' : '', m.needsSrn ? 'accepted SRN' : ''].filter(Boolean).join(' + ') || 'approval only'}${m.allowPartial ? ' · partial invoicing' : ''}</div></td><td class="r">${fmtNum(m.pct)}%</td><td class="r">${fmtNum(m.amount)}</td></tr>`).join('')}</tbody></table>` : ''}</div>`; } });
};

/* ----- amend PO ----- */
ACT['po-amend'] = el => {
  const po = getPO(el.dataset.id), ms = po.billingMethod === 'Milestone' ? msOf(po) : [];
  const lockedMs = msLocked, scopedPO = ms.some(m => !m.simple) || po.lines.some(isOutside), cf = poCfg(po), hasAdvInv = advsOf(po).some(a => advInvoiceOf(a));
  openModal({ title: `Amend ${po.number} (v${po.version} → v${po.version + 1})`, cls: 'xwide', submitLabel: 'Apply amendment', html: `
    ${alertBox('info', 'Historical records are preserved', 'Invoice allocations, receipts and approvals already recorded are never rewritten. Prices are locked on lines that already have receipts or invoices; quantities cannot fall below what is already received.')}
    <div class="sec-h">PO lines</div>
    <table class="tbl sm"><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit price</th><th class="right">Current value</th></tr></thead><tbody>${po.lines.map(l => { const touched = grnsOf(po).some(g => g.lineId === l.id) || srnsOf(po).some(s => s.lineId === l.id) || invsOf(po).some(isLive); return `<tr><td>${l.no}</td><td>${esc(l.desc)}</td><td><input class="input sm num" style="width:100px" name="q_${l.id}" type="number" step="any" value="${l.qty}"></td><td><input class="input sm num" style="width:120px" name="p_${l.id}" type="number" step="any" value="${l.price}" ${touched ? 'readonly title="Locked — receipts/invoices exist"' : ''}> ${touched ? icon('lock', 13) : ''}</td><td class="num">${fmtNum(lineNet(l))}</td></tr>`; }).join('')}</tbody></table>
    ${ms.length ? `<div class="sec-h">Milestone schedule <span class="hint" style="text-transform:none;font-weight:400">(% of the amended PO value — must total 100%; locked milestones keep their amount)</span></div>
    <table class="tbl sm"><thead><tr><th>ID</th><th>Name</th><th>%</th><th class="right">Current amount</th><th>Due date <span class="hint" style="text-transform:none;font-weight:400">(can always be rescheduled)</span></th><th>State</th><th>Cancel</th></tr></thead><tbody>${ms.map(m => { const lk = lockedMs(m); return `<tr><td class="strong">${m.code}</td><td><input class="input sm" name="mn_${m.id}" value="${esc(m.name)}" ${lk ? 'readonly' : ''}></td><td><input class="input sm num" style="width:100px" name="mv_${m.id}" type="number" step="any" value="${m.pct}" ${lk || !m.simple ? 'readonly title="Derived from the milestone scope"' : ''}></td><td class="num">${fmtNum(m.amount)}</td><td><input class="input sm" style="width:150px" type="date" name="md_${m.id}" value="${esc(m.planned || '')}"></td><td>${lk ? `<span class="lock">${icon('lock', 13)} Locked — ${usage('milestone', m.id).value > EPS ? 'invoiced' : m.status.toLowerCase()}</span>` : sb(m.status)}</td><td>${lk ? `<span class="hint" title="Submitted, approved or invoiced milestones cannot be cancelled">—</span>` : `<label class="check-row"><input type="checkbox" name="mx_${m.id}"> Remove</label>`}</td></tr>`; }).join('')}
      ${scopedPO ? `<tr><td class="strong">New</td><td colspan="6"><button type="button" class="btn btn-outline btn-sm" data-act="ms-amend-add" data-po="${po.id}">${icon('plus', 14)} Add milestone with scope…</button> <span class="hint">Scope, gates and advance terms are set in the milestone editor; use <b>Edit scope &amp; gates</b> in a milestone's drawer to re-assign an unsubmitted milestone.</span></td></tr>` : `<tr><td class="strong">New</td><td><input class="input sm" name="new_name" placeholder="Add milestone (optional)"></td><td><input class="input sm num" style="width:100px" name="new_val" type="number" step="any" placeholder="%"></td><td colspan="4" class="hint">Leave blank to skip (the new milestone starts Pending and needs no extra acceptance — edit it after if needed)</td></tr>`}</tbody></table>` : ''}
    ${po.billingMethod === 'Milestone' ? `<div class="sec-h">Billing controls <span class="hint" style="text-transform:none;font-weight:400">(Procurement)</span></div><div class="fgrid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${fld('Over-receipt tolerance (%)', 'st_overReceiptPct', { type: 'number', step: 'any', value: po.overReceiptPct || 0 })}${fld('Rate tolerance (%)', 'st_valueTolerancePct', { type: 'number', step: 'any', value: cf.valueTolerancePct })}${fld('Max advance per milestone (%)', 'st_maxAdvancePctPerMilestone', { type: 'number', step: 'any', value: cf.maxAdvancePctPerMilestone })}${fld('Max advances across the PO (%)', 'st_maxAdvancePctOfPO', { type: 'number', step: 'any', value: cf.maxAdvancePctOfPO })}${fld('GST on advances', 'st_advanceGstMode', { opts: [['taxed_on_advance', 'On the advance invoice'], ['taxed_at_final', 'At the final invoice']], value: cf.advanceGstMode, hint: hasAdvInv ? 'Locked — an advance invoice exists.' : '' })}${fld('Invoice due counted from', 'st_dueBasis', { opts: [['later', 'Later of receipt and acceptance'], ['receipt', 'Invoice receipt'], ['acceptance', 'Acceptance']], value: cf.dueBasis || 'later' })}${fld('Due in (days)', 'st_dueDays', { type: 'number', step: '1', value: cf.dueDays || '', ph: dueTerms(po).days + ' (by category)' })}<div class="field"><label>Dependencies</label><label class="check-row" style="margin-top:8px"><input type="checkbox" name="st_enforceDependencies" ${cf.enforceDependencies ? 'checked' : ''}> Every dependency is a gate</label></div></div>` : ''}
    <div style="margin-top:16px">${fld('Amendment reason', 'reason', { rows: 2, req: true, ph: 'Why is the PO being amended?' })}</div>`,
    onSubmit: v => {
      const lines = po.lines.map(l => ({ id: l.id, qty: +v['q_' + l.id], price: +v['p_' + l.id] }));
      const msIn = ms.map(m => ({ id: m.id, name: v['mn_' + m.id], pct: +v['mv_' + m.id], planned: v['md_' + m.id], remove: !!v['mx_' + m.id] }));
      if (!scopedPO && String(v.new_name || '').trim() && +v.new_val > 0) msIn.push({ id: 'new', name: v.new_name, pct: +v.new_val });
      const settings = po.billingMethod === 'Milestone' ? { overReceiptPct: v.st_overReceiptPct, valueTolerancePct: v.st_valueTolerancePct, maxAdvancePctPerMilestone: v.st_maxAdvancePctPerMilestone, maxAdvancePctOfPO: v.st_maxAdvancePctOfPO, advanceGstMode: v.st_advanceGstMode, enforceDependencies: !!v.st_enforceDependencies, dueBasis: v.st_dueBasis, dueDays: v.st_dueDays } : undefined;
      const r = A.amendPO(po.id, { lines, milestones: msIn, reason: v.reason, settings });
      if (!r.ok) { errorModal(r.msg, r.errors); return false; }
      toast(r.msg); render();
    } });
};

/* DICE-style timeline cards: who did what, with TAT chips */
function tlItems(po) {
  const ev = [...po.approvals].map(a => ({ t: a.action, who: a.by, at: a.at, note: a.note })).reverse();
  return ev.slice(0, 4).map((e, i, arr) => { const prev = arr[i + 1], tat = prev ? Math.max(0, Math.round((new Date(e.at) - new Date(prev.at)) / 60000)) : 0;
    return `<div class="tl-item"><div class="st"><span class="chip-done">COMPLETED</span><span class="chip-done">TAT: ${tat}m</span></div><div class="who"><span class="ok-dot"></span><div><b style="font-size:12px">${esc(e.t)}</b><div class="meta">${esc(e.who)}${e.note ? ' — ' + esc(e.note) : ''}<br>Sent on: ${fmtDT(e.at)}</div></div></div></div>`; });
}
function tatOf(po) { const a = po.approvals; if (!a.length) return '0m'; const m = Math.max(0, Math.round((new Date(a[a.length - 1].at) - new Date(po.createdAt)) / 60000)); return m < 60 ? m + 'm' : Math.round(m / 60) + 'h'; }
ACT['po-send'] = el => toast(`${getPO(el.dataset.id).number} PDF sent to ${getSup(getPO(el.dataset.id).supplierId).name} (simulated)`);
ACT['po-export'] = el => { const po = getPO(el.dataset.id), rows = db.audit.filter(a => a.poId === po.id).map(a => [fmtDT(a.at), a.by, a.ref, a.text].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
  const url = URL.createObjectURL(new Blob([['"When","By","Ref","Event"', ...rows].join('\n')], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = `timeline-${po.id}.csv`; document.body.appendChild(a); a.click(); a.remove(); toast('Timeline exported'); };
