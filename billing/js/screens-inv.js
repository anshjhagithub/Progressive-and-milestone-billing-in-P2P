/* =====================================================================
   screens-inv.js — invoices (list / Submit Invoice drawer / detail), approvals queue, AP register
   ===================================================================== */
const matchBadge = i => i.match ? sb(i.match.result) : '<span class="dim-note">Not run</span>';
const INV_STATUSES = ['Draft', 'Matching Failed', 'Pending Approval', 'Approved', 'Posted', 'Paid', 'Rejected', 'Cancelled'];

/* ================================================================ list */
ROUTES.invoices = () => `<div class="page"><h1 class="page-title">Invoice Management</h1>${listHtml('invoices', {
  noun: 'invoices', searchPh: 'Search invoice, bill no., PO, vendor…', dates: true,
  tabs: [['pending', 'Pending', i => ['Draft', 'Matching Failed', 'Pending Approval', 'Submitted', 'Pending Matching'].includes(i.status)], ['approved', 'Approved', i => ['Approved', 'Posted'].includes(i.status)], ['paid', 'Paid', i => i.status === 'Paid'], ['other', 'Rejected / Cancelled', i => ['Rejected', 'Cancelled'].includes(i.status)], ['all', 'All', () => true]],
  filters: [{ name: 'method', label: 'Billing', options: () => ['Standard', 'Progressive', 'Milestone'] }, { name: 'supplier', label: 'Vendor', options: () => supOpts() }, { name: 'po', label: 'PO', options: () => db.pos.filter(p => invsOf(p).length).map(p => [p.id, p.number]) }],
  above: gbtn('inv.create', 'inv-new', 'Submit Invoice', { cls: 'btn-primary', icn: 'plus', data: { po: '' } }),
  rows: () => db.invoices.slice().sort((a, b) => b.seq - a.seq),
  match: (i, st) => matchText(st, i.number, invRef(i), getPO(i.poId).number, getSup(i.supplierId).name) && matchIn(st, 'method', i.method) && matchIn(st, 'supplier', i.supplierId) && matchIn(st, 'po', i.poId) && matchDate(st, i.date),
  cols: ['Invoice', 'Bill No.', 'PO', 'Vendor', 'Billing', 'Bill Date', '>Base', '>GST', '>Total', 'Matching', 'Status', ''],
  row: i => `<tr class="click" data-act="inv-view" data-id="${i.id}"><td class="strong">${invRef(i)}</td><td>${esc(i.number)}</td><td>${esc(getPO(i.poId).number)}</td><td>${esc(getSup(i.supplierId).name)}</td><td>${mb(i.method)}</td><td class="nowrap">${fmtD(i.date)}</td><td class="num">${fmtNum(i.net)}</td><td class="num">${fmtNum(i.gst)}</td><td class="num strong">${fmtNum(i.gross)}</td><td>${matchBadge(i)}</td><td>${sb(i.status)}${i.reversed ? ' <span class="pill red">Reversed</span>' : ''}${apReview(i) ? ' <span class="pill red" title="Source entitlement dropped after approval">AP review</span>' : ''}</td><td class="act"><button class="btn-view" data-act="inv-view" data-id="${i.id}">${icon('open', 12, 2)}View</button></td></tr>`,
})}</div>`;
ROUTES.invoice = r => { const i = getInv(r.parts[1]); return i ? invDetail(i) : notFound('Invoice'); };

/* ================================================================ Submit Invoice drawer */
ACT['inv-new'] = el => openInvPanel({ poId: el.dataset.po, msId: el.dataset.ms, advId: el.dataset.adv });
ACT['inv-edit'] = el => openInvPanel({ invId: el.dataset.id });
const DEPTS = ['Finance', 'Operations', 'IT', 'Procurement', 'Admin', 'Projects'];
function openInvPanel({ poId, msId, advId, invId, recKind, recId, ocr }) {
  const rec = recId && (recKind === 'grn' ? getGRN(recId) : getSRN(recId)); if (rec) poId = rec.poId;
  openPanel({ key: 'inv', wide: true, title: invId ? `Edit ${invRef(getInv(invId))}` : 'Submit Invoice', sub: 'Fill out the details',
    init: () => {
      if (invId) { const i = getInv(invId), alloc = {}; i.allocs.forEach(a => { alloc[a.kind + ':' + a.refId] = { on: true, qty: a.qty, value: a.value }; });
        return { id: i.id, poId: i.poId, fixed: true, number: i.number, date: i.date, dueDate: i.dueDate || '', remarks: i.remarks, attachments: [...i.attachments], net: i.net, alloc, discountPct: i.discountPct || '', tcs: i.tcs || '', roundOff: i.roundOff || '', gstCredit: !!i.gstCredit, createAsn: !!i.createAsn, costType: (i.costAlloc || {}).type || '', costRows: ((i.costAlloc || {}).rows || []).map(r => ({ ...r })), picker: true }; }
      const po = poId && getPO(poId), ok = po && po.status === 'Approved';
      const f = { id: null, idem: uid('sub'), snap: {}, poId: ok ? po.id : '', fixed: !!ok, number: '', date: todayISO(), dueDate: '', autoDue: '', remarks: '', attachments: [], net: '', alloc: {}, discountPct: '', tcs: '', roundOff: '', gstCredit: false, createAsn: false, costType: '', costRows: [], picker: true };
      if (ok && msId && po.billingMethod === 'Milestone') { const it = sourceItems(po).find(x => x.kind === 'milestone' && x.refId === msId); if (it && it.eligible) f.alloc['milestone:' + msId] = { on: true, value: it.availValue }; }
      if (ok && rec) {                                        // opened from a GRN / SRN: preselect it
        const it = sourceItems(po).find(x => x.kind === recKind && x.refId === recId);
        if (po.billingMethod === 'Milestone') { const m = rec.milestoneId && getMS(rec.milestoneId); const mi = m && sourceItems(po).find(x => x.kind === 'milestone' && x.refId === m.id); if (mi && mi.eligible) f.alloc['milestone:' + m.id] = { on: true, value: mi.availValue }; }
        else if (po.billingMethod === 'Progressive' && it && it.eligible) f.alloc[recKind + ':' + recId] = recKind === 'grn' ? { on: true, qty: it.availQty } : { on: true, value: it.availValue };
        else if (po.billingMethod === 'Standard' && it) f.net = it.availValue || it.entValue || '';
      }
      if (ok && advId && po.billingMethod === 'Milestone') { const it = sourceItems(po).find(x => x.kind === 'advance' && x.refId === advId); if (it && it.eligible) f.alloc['advance:' + advId] = { on: true, value: it.ref.base }; }
      if (ok && !Object.keys(f.alloc).length && !f.net) fetchLines(f, po);
      if (ok) snapAlloc(f, po);
      if (ok && ocr) { f.number = 'OCR-' + String(Date.now()).slice(-6); f.attachments = ['scanned-invoice.pdf']; }
      return f; },
    body: invBody, foot: () => '', derive: invDerive });
  if (ocr) setTimeout(() => toast('Invoice details read from the scanned invoice (simulated OCR) — check and submit'), 60);
}
/* pull everything that can be billed on the PO into the invoice lines (the user can delete or edit lines afterwards) */
function fetchLines(f, po) {
  f.alloc = {}; f.net = '';
  if (po.billingMethod === 'Standard') { const r = poSummary(po).remaining; if (r > 0) f.net = r; return; }
  sourceItems(po, f.id).forEach(it => {
    if (!it.eligible || it.kind === 'advance') return;
    f.alloc[it.kind + ':' + it.refId] = it.kind === 'grn' ? { on: true, qty: it.availQty } : { on: true, value: it.availValue > 0 ? it.availValue : (it.ref.amount || it.entValue) };
  });
}
HOOKS.invpo = () => { ui.f.alloc = {}; ui.f.snap = {}; ui.f.net = ''; const po = getPO(ui.f.poId); if (po && po.status === 'Approved') { fetchLines(ui.f, po); snapAlloc(ui.f, po); } };
/* remember the balance each selected source had when it was added; the engine compares at submit (STALE) */
function snapAlloc(f, po) {
  f.snap = {};
  if (!po || po.billingMethod === 'Standard') return;
  sourceItems(po, f.id).forEach(it => { const k = it.kind + ':' + it.refId; if (f.alloc[k] && f.alloc[k].on) f.snap[k] = it.kind === 'grn' ? it.availQty : it.availValue; });
}
function invAllocs(f, po) {
  const out = [];
  sourceItems(po, f.id).forEach(it => {
    const a = f.alloc[it.kind + ':' + it.refId]; if (!a || !a.on) return;
    if (it.kind === 'grn') { const qty = +a.qty || 0; out.push({ kind: 'grn', refId: it.refId, qty, value: r2(qty * it.price) }); }
    else if (it.kind === 'milestone') out.push({ kind: 'milestone', refId: it.refId, qty: null, value: it.ref.allowPartial ? r2(+a.value || 0) : it.ref.amount, ...(a.lines && a.lines.length ? { lines: a.lines } : {}) });
    else if (it.kind === 'advance') out.push({ kind: 'advance', refId: it.refId, qty: null, value: it.ref.base });
    else out.push({ kind: it.kind, refId: it.refId, qty: null, value: r2(+a.value || 0) });
  });
  return out;
}
const invDraftObj = f => { const po = getPO(f.poId); return { id: f.id, poId: f.poId, number: f.number, date: f.date, dueDate: f.dueDate, remarks: f.remarks, attachments: f.attachments, allocs: po && po.billingMethod !== 'Standard' ? invAllocs(f, po) : [], net: +f.net || 0, discountPct: f.discountPct, tcs: f.tcs, roundOff: f.roundOff, gstCredit: f.gstCredit, createAsn: f.createAsn, costAlloc: { type: f.costType, rows: f.costRows }, autoMatch: true, idemKey: f.idem, snap: f.snap }; };
const tgl = (path, label, on) => `<div class="tglrow"><span>${label}</span><button type="button" class="toggle ${on ? 'on' : ''}" data-act="inv-toggle" data-path="${path}" aria-label="${label}"><i></i></button></div>`;
ACT['inv-toggle'] = el => { setPath(ui.f, el.dataset.path, !getPath(ui.f, el.dataset.path)); render(); };
function invBody() {
  const f = ui.f, po = getPO(f.poId), pos = approvedPOs();
  const head = f.fixed && po ? '' : `<div class="field"><label>Purchase order <span class="req">*</span></label><select class="input" data-f="poId" data-r data-hook="invpo"><option value="">Select an approved PO</option>${opt(pos.map(p => [p.id, `${p.number} — ${getSup(p.supplierId).name} (${p.billingMethod})`]), f.poId)}</select></div>`;
  if (!po) return `<div class="panel-split" style="grid-template-columns:minmax(0,1fr)"><div class="fm">${head}<div class="empty-state">Select an approved PO. Its billing method (Standard, Progressive or Milestone) decides what you can invoice.</div></div></div>`;
  const rows = invLineRows(f, po), L = recName(po), costBase = f.costType === 'total' ? 'Total Amount' : 'Base Amount';
  return `<div class="panel-split"><div class="pv" id="pv"></div><div class="fm">${head}
    <div class="field"><label>Attachment</label>${attachBox('attachments', f.attachments)}</div>
    ${tgl('gstCredit', 'GST Credit Applicable', f.gstCredit)}${tgl('createAsn', 'Create ASN', f.createAsn)}
    <div class="field" style="margin-top:18px"><label>Category</label><div class="ro">${esc(po.category)}</div></div>
    <div class="field"><label>Bill Number <span class="req">*</span></label><input class="input" data-f="number" value="${esc(f.number)}" placeholder="Enter the bill Number"></div>
    <div class="fgrid">${F.text('Bill Date', 'date', { type: 'date', req: 1 })}${F.text('Due Date', 'dueDate', { type: 'date' })}</div><div class="fhint" id="due-hint" style="margin:-6px 0 10px"></div>
    <div class="field" style="margin-bottom:8px"><label style="text-transform:none;font-size:13px;font-weight:500;letter-spacing:0;color:var(--text)">Line Items<span class="req"> *</span></label>
    <table class="li-table"><thead><tr><th>Details</th><th style="width:78px">Qty</th><th style="width:104px">Price</th><th style="width:70px">Tax</th><th style="width:74px">Cost Allocation</th><th style="width:86px">Action</th></tr></thead><tbody>
    ${rows.map(r => invLineRow(r, po)).join('') || `<tr><td class="empty" colspan="6">No Line Items Added — use “+ Add Line Item” below</td></tr>`}</tbody></table></div>
    ${po.billingMethod === 'Standard' ? invStdHint(po) : `<div class="li-actions" style="margin:4px 0 6px"><button type="button" class="addline" data-act="inv-line-add">+ Add Line Item</button>${po.billingMethod === 'Milestone' ? '<button type="button" class="stub-btn" data-act="inv-intake" title="Match a multi-line supplier invoice to PO lines and milestones">Match supplier lines…</button>' : ''}</div>`}
    <div class="field" style="margin-top:20px"><label>Discount Percent</label><input class="input" type="number" min="0" max="100" step="any" data-t="num" data-f="discountPct" value="${esc(f.discountPct)}" placeholder="Enter the discount percentage"><div class="fhint" style="color:var(--danger)">Discount will be applied before tax</div></div>
    <div class="field"><label>Total Amount</label><div class="ro" id="inv-total"></div></div>
    <div class="field"><label>TCS (Tax Collected at Source)</label><input class="input" type="number" step="any" data-t="num" data-f="tcs" value="${esc(f.tcs)}" placeholder="Enter TCS amount"></div>
    <div class="field"><label>Round Off Amount</label><input class="input" type="number" step="any" data-t="num" data-f="roundOff" value="${esc(f.roundOff)}" placeholder="Enter the round off amount"></div>
    <div id="cost-sec"><div style="font-weight:700;margin:22px 0 8px">Cost Allocation</div>
      <div class="row" style="gap:18px;margin-bottom:6px"><b style="font-size:12.5px">Cost Allocation Type:</b>${['base', 'total'].map(t => `<label class="check-row" style="font-size:11px;text-transform:uppercase;color:var(--muted)"><input type="checkbox" ${f.costType === t ? 'checked' : ''} data-act="cost-type" data-t="${t}"> ${t} amount</label>`).join('')}</div>
      <div class="hint">Choose Base Amount or Total Amount to start the allocation.</div><div class="hint" style="margin-bottom:10px">Click + Add and choose the cost allocation type. Leave empty to skip.</div>
      <table class="li-table"><thead><tr><th>Department</th><th style="width:100px">Percentage</th><th style="width:110px">Amount</th><th style="width:60px">Action</th></tr></thead><tbody>
      ${f.costRows.map((r, i) => `<tr><td><select class="input" data-f="costRows.${i}.dept"><option value="">Select department</option>${opt(DEPTS, r.dept)}</select></td><td><input class="input num" type="number" min="0" step="any" data-t="num" data-f="costRows.${i}.pct" value="${esc(r.pct)}"></td><td class="num" id="ca-amt-${i}"></td><td style="text-align:center"><button type="button" class="icon-btn danger" data-act="cost-del" data-i="${i}">${icon('trash', 15)}</button></td></tr>`).join('') || ''}</tbody></table>
      <button type="button" class="link" style="margin:10px 0" data-act="cost-add" ${f.costType ? '' : 'disabled'}>+ Add</button></div>
    <div id="inv-sum" style="margin-top:14px"></div>
    <div class="row" style="margin:18px 0 6px;gap:12px"><button class="btn btn-primary" style="min-width:110px" data-act="inv-save" data-m="submit" ${can('inv.create') ? '' : 'disabled'}>Submit</button>${gbtn('inv.create', 'inv-save', 'Save as Draft', { cls: 'btn-ghost', data: { m: 'draft' } })}</div>
    ${can('inv.create') ? '' : roleBanner('inv.create', 'Submitting an invoice')}
    </div></div>`;
}
function invLineRows(f, po) {
  if (po.billingMethod === 'Standard') return [{ key: 'std', std: true }];
  return sourceItems(po, f.id).filter(it => f.alloc[it.kind + ':' + it.refId]?.on).map(it => ({ key: it.kind + ':' + it.refId, it, a: f.alloc[it.kind + ':' + it.refId] }));
}
function invLineRow(r, po) {
  const cj = `<button type="button" class="plus-circle sm" data-act="cost-jump" title="Allocate cost">${icon('plus', 14, 2.4)}</button>`;
  if (r.std) return `<tr><td><b>${po.type === 'Mixed' ? 'Goods & services' : isGoods(po) ? 'Goods' : 'Services'} accepted against the PO</b><div class="sub">PO level · ${esc(po.number)}</div></td><td class="num">1</td><td><input class="input num" type="number" min="0" step="any" data-t="num" data-f="net" value="${esc(ui.f.net)}" placeholder="0.00"></td><td class="num" id="il-tax-std"></td><td style="text-align:center">${cj}</td><td></td></tr>`;
  const it = r.it, g = it.kind === 'grn';
  const name = g ? esc(it.line.desc) : it.kind === 'srn' ? esc(it.ref.description) : it.kind === 'milestone' ? `${it.ref.code} — ${esc(it.ref.name)}` : it.kind === 'advance' ? esc(it.name) : `${esc(it.ref.number)} · ${esc(it.ref.period)}`;
  const qty = g ? `<input class="input num" type="number" min="0" step="any" data-t="num" data-f="alloc.${r.key}.qty" value="${r.a.qty ?? ''}">` : '1';
  const price = g ? `<div class="num">${fmtNum(it.price)}</div>` : it.kind === 'advance' ? `<div class="num">${fmtNum(it.ref.base)}</div>` : it.kind === 'milestone' && !it.ref.allowPartial && !(r.a.lines && r.a.lines.length) ? `<div class="num">${fmtNum(it.ref.amount)}</div>` : `<input class="input num" type="number" min="0" step="any" data-t="num" data-f="alloc.${r.key}.value" value="${r.a.value ?? ''}">`;
  return `<tr><td><b>${name}</b><div class="sub">${esc(it.label)} · ${it.kind === 'advance' ? esc(it.status) : fmtD(it.ref.date || it.ref.planned)}${r.a.lines && r.a.lines.length ? ` · ${r.a.lines.length} supplier line(s) matched` : ''}</div></td><td class="num">${qty}</td><td>${price}</td><td class="num" id="il-tax-${r.key}"></td><td style="text-align:center">${cj}</td><td style="white-space:nowrap"><button type="button" class="link" data-act="inv-edit-line" data-key="${r.key}">Edit</button> <button type="button" class="link" style="color:var(--danger)" data-act="inv-del-line" data-key="${r.key}">Delete</button></td></tr>`;
}
const invStdHint = po => { const s = poSummary(po); return `<div class="li-actions"><button type="button" class="link" data-act="inv-full-std">Use the full available balance (${money(s.remaining)})</button></div>${noteBox('gray', 'doc', `<b>Standard billing</b> — matched against accepted ${recName(po)}s at PO level. Accepted <b>${money(s.accepted)}</b>, already invoiced <b>${money(r2(s.accepted - s.remaining))}</b>.`)}`; };
/* "+ Add Line Item" → dialog listing what can still be invoiced (search, tick, Add) — as in DICE */
ACT['inv-line-add'] = () => {
  const f = ui.f, po = getPO(f.poId), L = recName(po), g = isGoods(po);
  const items = sourceItems(po, f.id).filter(x => x.eligible && !f.alloc[x.kind + ':' + x.refId]?.on);
  const blocked = sourceItems(po, f.id).filter(x => !x.eligible && !f.alloc[x.kind + ':' + x.refId]?.on);
  const intro = po.billingMethod === 'Milestone' ? 'Only approved milestones whose acceptance conditions (document, accepted GRN / SRN) are met appear here. Milestones that allow partial invoicing can be billed in parts up to the remaining balance; others are billed in full, once.'
    : poCertified(po) ? 'Only newly certified, unbilled progress appears here.' : `Only accepted ${L}s with quantity still left appear here — pending, rejected and fully used ${g ? 'units' : 'value'} never qualify.`;
  const row = x => { const m = x.ref, key = x.kind + ':' + x.refId;
    const nm = x.kind === 'milestone' ? `${m.code} — ${esc(m.name)}` : x.kind === 'advance' ? esc(x.name) : x.kind === 'claim' ? `${x.label} · ${esc(m.period)}` : x.kind === 'grn' ? `${esc(x.line.desc)}` : esc(m.description);
    const ref = x.kind === 'milestone' ? `Due ${fmtD(m.planned)}` : x.kind === 'advance' ? `${x.label} · ${x.status}` : `${x.label} · ${fmtD(m.date)}`;
    return `<tr data-q="${esc((nm + ' ' + ref).toLowerCase())}"><td style="width:46px"><input type="checkbox" data-pick="${key}" style="accent-color:var(--primary);width:17px;height:17px"></td><td><b>${nm}</b><div class="sub">${esc(ref)}</div></td><td class="num">${fmtNum(x.kind === 'grn' ? x.price : x.availValue)}</td><td class="num">${x.kind === 'grn' ? fmtNum(x.availQty) : 1}</td><td class="num">${fmtNum(x.availValue)}</td></tr>`; };
  const ov = openModal({ title: 'Add Line Item', cls: 'wide', submitLabel: 'Add', html: `<p style="margin:-6px 0 14px;font-size:12.5px">select line items to add</p>
    <p class="hint" style="margin:0 0 12px">${esc(intro)}</p>
    <div class="modal-search">${icon('search', 15)}<input placeholder="Search" data-mfilter autocomplete="off"></div>
    <div class="tbl-wrap" style="margin-top:14px;max-height:340px;overflow:auto"><table class="tbl sm"><thead><tr><th style="width:46px"><input type="checkbox" data-pickall style="accent-color:var(--primary);width:17px;height:17px"></th><th>DETAILS</th><th class="right">PRICE</th><th class="right">QUANTITY</th><th class="right">AMOUNT(INR)</th></tr></thead><tbody>${items.map(row).join('') || `<tr><td colspan="5" class="empty"><div class="noitems">${icon('box', 34, 1.4)}<span>No Items found</span></div>${blocked.length ? `<div class="hint" style="margin-top:6px">${esc(blocked[0].label)}: ${esc(blocked[0].reason)}${blocked.length > 1 ? ` (+${blocked.length - 1} more not eligible)` : ''}</div>` : ''}</td></tr>`}</tbody></table></div>`,
    onSubmit: (v, form) => {
      const keys = [...form.querySelectorAll('input[data-pick]:checked')].map(c => c.dataset.pick);
      if (!keys.length) { toast('Tick at least one line item to add', 'err'); return false; }
      const all = sourceItems(po, f.id);
      keys.forEach(key => { const it = all.find(x => x.kind + ':' + x.refId === key); if (!it) return;
        f.alloc[key] = it.kind === 'grn' ? { on: true, qty: it.availQty } : { on: true, value: it.availValue > 0 ? it.availValue : (it.ref.amount || it.entValue) }; });
      snapAlloc(f, po); render();
    } });
  const qf = ov.querySelector('[data-mfilter]'); if (qf) qf.addEventListener('input', () => { const q = qf.value.toLowerCase(); ov.querySelectorAll('tbody tr[data-q]').forEach(tr => { tr.style.display = tr.dataset.q.includes(q) ? '' : 'none'; }); });
  const pa = ov.querySelector('[data-pickall]'); if (pa) pa.addEventListener('change', () => ov.querySelectorAll('input[data-pick]').forEach(c => { if (c.closest('tr').style.display !== 'none') c.checked = pa.checked; }));
};
ACT['inv-del-line'] = el => { delete ui.f.alloc[el.dataset.key]; render(); };
ACT['inv-edit-line'] = el => { const row = el.closest('tr'); const inp = row && row.querySelector('input'); if (inp) { inp.focus(); inp.select(); } else toast('This line is billed in full and cannot be edited', 'err'); };
ACT['inv-full-std'] = () => { ui.f.net = poSummary(getPO(ui.f.poId)).remaining; render(); };
ACT['cost-type'] = el => { ui.f.costType = ui.f.costType === el.dataset.t ? '' : el.dataset.t; if (!ui.f.costType) ui.f.costRows = []; render(); };
ACT['cost-add'] = () => { ui.f.costRows.push({ dept: '', pct: Math.max(0, r2(100 - sum(ui.f.costRows, r => +r.pct || 0))) }); render(); };
ACT['cost-del'] = el => { ui.f.costRows.splice(+el.dataset.i, 1); render(); };
ACT['cost-jump'] = () => { const s = $('#cost-sec'); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
ACT['inv-add-sample'] = () => {};

/* left-hand invoice document, laid out like the DICE "Submit Invoice" preview */
function invPreview(f, po, b) {
  const sup = getSup(po.supplierId), off = officeOf(po.office);
  const rows = b.allocs.map(a => {
    if (a.kind === 'grn') { const g = getGRN(a.refId), l = lineOf(po, g.lineId); return [l.desc, `${g.number}`, l.price, a.qty, a.value]; }
    if (a.kind === 'srn') { const s = getSRN(a.refId); return [s.description, s.number, a.value, 1, a.value]; }
    if (a.kind === 'milestone') { const m = getMS(a.refId); return [m.name, m.code, a.value, 1, a.value]; }
    if (a.kind === 'advance') { const x = getAdv(a.refId), m = getMS(x.msId); return [`Advance — ${m.code} ${m.name}`, x.number, a.value, 1, a.value]; }
    const c = getClaim(a.refId); return [`Certified progress — ${c.period}`, c.number, a.value, 1, a.value];
  });
  ((b.recovery && b.recovery.items) || []).forEach(x => { const m = getMS(x.msId); rows.push([`Advance recovered, ${m.code}`, x.number, -x.net, 1, -x.net, poCfg(po).advanceGstMode === 'taxed_at_final']); });
  ((b.damages && b.damages.items) || []).forEach(x => rows.push([`Delay damages, ${x.code} (${x.lateDays}d late = ${x.weeks} wk × ${x.ratePct}%${x.capped ? ', capped' : ''})`, 'deducted from payable', -x.amount, 1, -x.amount, true]));
  if (po.billingMethod === 'Standard' && b.net > 0) rows.push([isGoods(po) ? 'Goods accepted against the PO' : 'Services accepted against the PO', 'PO level', b.net, 1, b.net]);
  const same = String(sup.gstin).slice(0, 2) === String(off.gstin).slice(0, 2), half = r2(b.gst / 2);
  return `<div class="dv"><h3>INVOICE</h3>
    <div class="dv-box"><div><b>Vendor</b><br>${esc(sup.name)}<br>${esc(sup.addr || 'K Block')}<br>${esc(sup.email)}<br>${esc(sup.gstin)}</div><div class="r">Due Date: ${f.dueDate ? fmtD(f.dueDate) : ''}<br>Bill Number: ${esc(f.number)}</div></div>
    <div class="dv-addr"><div><b>Billing Address</b><br>${esc(off.name)}</div><div class="r"><b>Shipping Address</b></div></div>
    <div class="dv-addr small"><div>${esc(off.address)}<br>Gstin : ${esc(off.gstin)}</div><div class="r">NA<br>Gstin : NA</div></div>
    <table class="dv-tbl"><thead><tr><th>Description</th><th class="r">Price</th><th class="r">Qty</th><th class="r">Base Amt</th><th class="r">Gross Amt</th><th class="r">Tax Amt</th><th class="r">Cess Amt</th><th class="r">Gst %</th><th class="r">Amount (INR)</th></tr></thead><tbody>
    ${rows.map(([d, ref, price, qty, base, noTax]) => { const gst = noTax ? 0 : r2(base * (1 - b.discountPct / 100) * b.gstRate / 100); return `<tr><td>${esc(d)}<div class="sm">${esc(ref)}</div><div class="sm">${esc(po.category)}</div></td><td class="r">${fmtNum(price)}</td><td class="r">${fmtNum(qty)}</td><td class="r">${fmtNum(base)}</td><td class="r">${fmtNum(base)}</td><td class="r">${fmtNum(gst)}</td><td class="r">0</td><td class="r">${b.gstRate}</td><td class="r">${fmtNum(r2(base * (1 - b.discountPct / 100) + gst))}</td></tr>`; }).join('') || '<tr><td colspan="9" class="muted" style="text-align:center;padding:30px">Pick what you are invoicing — the invoice lines appear here.</td></tr>'}</tbody></table>
    <table class="dv-tot"><tbody><tr><td>Base Amt:</td><td>${fmtNum(b.net)}</td></tr><tr><td>Discount Amt:</td><td>${fmtNum(b.discount)}</td></tr><tr><td>SGST / UTGST:</td><td>${fmtNum(same ? half : 0)}</td></tr><tr><td>CGST:</td><td>${fmtNum(same ? half : 0)}</td></tr><tr><td>IGST:</td><td>${fmtNum(same ? 0 : b.gst)}</td></tr><tr class="b"><td>Tax Amt:</td><td>${fmtNum(b.gst)}</td></tr>${b.tcs ? `<tr><td>TCS:</td><td>${fmtNum(b.tcs)}</td></tr>` : ''}${b.roundOff ? `<tr><td>Round Off:</td><td>${fmtNum(b.roundOff)}</td></tr>` : ''}<tr><td>Cess Amt:</td><td>0</td></tr><tr class="b"><td>Total Amt:</td><td>${fmtNum(b.gross)}</td></tr>${recoveryCash(b) ? `<tr><td>Advance recovered (incl. GST reversed):</td><td>−${fmtNum(recoveryCash(b))}</td></tr>` : ''}${damagesCash(b) ? `<tr><td>Delay damages:</td><td>−${fmtNum(damagesCash(b))}</td></tr>` : ''}${b.tdsDeducted ? `<tr><td>TDS deducted:</td><td>−${fmtNum(b.tdsDeducted)}</td></tr>` : ''}${recoveryCash(b) || damagesCash(b) || b.tdsDeducted ? `<tr class="b"><td>Payable:</td><td>${fmtNum(r2(b.gross - recoveryCash(b) - damagesCash(b) - (b.tdsDeducted || 0)))}</td></tr>` : ''}</tbody></table></div>`;
}
function invDerive() {
  const f = ui.f, po = getPO(f.poId); if (!po || !$('#inv-sum')) return;
  /* invoice due = later of receipt and acceptance + the PO's due days (D10 / D11) — typed dates are left alone */
  { const acc = (invAllocs(f, po).filter(a => a.kind !== 'advance').map(a => a.kind === 'milestone' ? ((getMS(a.refId) || {}).approvedAt || '').slice(0, 10) : a.kind === 'grn' ? (getGRN(a.refId) || {}).date : a.kind === 'srn' ? (getSRN(a.refId) || {}).date : '').filter(Boolean).sort().pop()) || '';
    const sp = invoiceDueSplit(po, { allocs: invAllocs(f, po), date: f.date || todayISO() }), due0 = invoiceDue(po, f.date || todayISO(), acc), due = sp ? { ...due0, date: sp.earliest } : due0, el = $('.panel [data-f="dueDate"]');
    if (!f.dueDate || f.dueDate === f.autoDue) { f.dueDate = due.date; if (el) el.value = due.date; } f.autoDue = due.date;
    const h = $('#due-hint'); if (h) h.textContent = `Due ${due.days} days after ${due.basis === 'later' ? 'the later of receipt and acceptance' : due.basis === 'receipt' ? 'invoice receipt' : 'acceptance'} (${fmtD(due.base)})${sp && sp.split.length > 1 ? ` Several milestones: ${sp.split.map(x => fmtD(x.due)).join(' / ')} — the earliest is used.` : ''}${f.dueDate !== due.date ? ' — you changed the date' : ''}.`; }
  const d = invDraftObj(f), b = buildInvoice({ ...d, supplierId: po.supplierId, method: po.billingMethod }), ev = evaluateInvoice(b), gate = ev.errors || [];
  const pv = $('#pv'); if (pv) pv.innerHTML = invPreview(f, po, b);
  const tot = $('#inv-total'); if (tot) tot.textContent = `INR ${b.gross.toFixed(2)}${recoveryCash(b) || damagesCash(b) ? `  (payable ${r2(b.gross - recoveryCash(b) - damagesCash(b) - (b.tdsDeducted || 0)).toFixed(2)} after ${[recoveryCash(b) ? 'the advance recovery' : '', damagesCash(b) ? 'delay damages' : ''].filter(Boolean).join(' and ')})` : ''}`;
  b.allocs.forEach(a => { const e = document.getElementById('il-tax-' + a.kind + ':' + a.refId); if (e) e.textContent = fmtNum(a.kind === 'advance' && poCfg(po).advanceGstMode === 'taxed_at_final' ? 0 : r2(a.value * (1 - b.discountPct / 100) * b.gstRate / 100)); });
  const es = document.getElementById('il-tax-std'); if (es) es.textContent = fmtNum(r2(b.net * (1 - b.discountPct / 100) * b.gstRate / 100));
  const base = f.costType === 'total' ? b.gross : r2(b.net - b.discount);
  f.costRows.forEach((r, i) => { const e = document.getElementById('ca-amt-' + i); if (e) e.textContent = fmtNum(r2(base * (+r.pct || 0) / 100)); });
  const caTot = sum(f.costRows, r => +r.pct || 0);
  const costWarn = f.costRows.length && Math.abs(caTot - 100) > 0.0001 ? alertBox('warn', 'Cost allocation', `Percentages total ${fmtNum(caTot)}% — they must total 100%.`) : '';
  $('#inv-sum').innerHTML = `${costWarn}${gate.length ? alertBox('err', 'This invoice would be blocked', errList(gate)) : alertBox('ok', 'Ready to submit', `Base ${money(b.net)}${b.discount ? ` − discount ${money(b.discount)}` : ''} + GST ${money(b.gst)} = ${money(b.gross)}. It is matched against the PO and receipts on submit, then routed to the AP Manager.`)}`;
}
ACT['inv-save'] = el => { const m = el.dataset.m, f = ui.f, r = A.saveInvoice(invDraftObj(f), m);
  if (!r.ok) snapAlloc(f, getPO(f.poId));                                                // after a STALE / blocked submit the screen now reflects the refreshed balances
  done(r, x => { closePanel(); go(`#/invoice/${x.id}`); }); };

/* ================================================================ detail */
function allocState(inv) { return isLive(inv) ? (APPROVED.includes(inv.status) ? 'Committed' : 'Reserved') : (inv.status === 'Draft' ? 'Not reserved' : 'Released'); }
function invDetail(i) {
  const po = getPO(i.poId), sup = getSup(i.supplierId), adj = adjOf(i);
  const bn = { Draft: ['gray', 'Draft — nothing reserved', 'Submit the invoice to reserve receipt / milestone entitlements and run matching.'], 'Matching Failed': ['red', 'Matching failed — blocked', 'Reservations are held back. Resolve the exceptions below, edit the invoice and re-submit, or re-run matching.'], 'Pending Approval': ['amber', 'Pending approval', `Matching ${i.match ? i.match.result.toLowerCase() : ''}. Routed to the AP Manager. Allocations are reserved.`], Approved: ['green', 'Approved — ready to post to AP', 'Allocations are committed.'], Rejected: ['red', 'Rejected', 'Allocations released back to the eligible balance.'], Posted: ['green', 'Posted to AP (simulated)', `Voucher ${i.ap?.voucher}. Awaiting payment.`], Paid: ['green', 'Paid (demo)', `Reference ${i.ap?.payRef}. No real bank payment was made.`], Cancelled: ['gray', 'Cancelled', 'Allocations released.'], Submitted: ['amber', 'Submitted', 'Awaiting matching.'], 'Pending Matching': ['amber', 'Pending matching', 'Run matching to validate the invoice.'] }[i.status];
  const acts = [], more = [];
  if (['Draft', 'Matching Failed'].includes(i.status)) acts.push(gbtn('inv.create', 'inv-edit', 'Edit', { icn: 'edit', data: { id: i.id }, cls: 'btn-outline' }));
  if (i.status === 'Draft') acts.push(gbtn('inv.create', 'inv-submit-existing', 'Submit Invoice', { cls: 'btn-primary', data: { id: i.id }, icn: 'check' }));
  if (['Submitted', 'Pending Matching', 'Matching Failed', 'Pending Approval'].includes(i.status)) acts.push(gbtn('inv.match', 'inv-match', i.status === 'Pending Approval' ? 'Re-run matching' : 'Run matching', { cls: 'btn-outline', data: { id: i.id }, icn: 'play' }));
  if (i.status === 'Pending Approval') acts.push(gbtn('inv.approve', 'inv-reject', 'Reject', { cls: 'btn-danger', data: { id: i.id } }), gbtn('inv.approve', 'inv-approve', 'Approve', { cls: 'btn-primary', data: { id: i.id }, icn: 'check' }));
  if (i.status === 'Approved') acts.push(gbtn('inv.post', 'inv-post', 'Post to AP', { cls: 'btn-primary', data: { id: i.id } }));
  if (i.status === 'Posted') acts.push(gbtn('inv.post', 'inv-pay', 'Mark as Paid (demo)', { cls: 'btn-primary', data: { id: i.id } }));
  if (['Posted', 'Paid'].includes(i.status) && !i.reversed && can('inv.reverse')) more.push({ label: 'Reverse via credit note', icon: 'back', danger: true, run: () => ACT['inv-reverse']({ dataset: { id: i.id } }) });
  if (APPROVED.includes(i.status) && can('inv.adjust')) more.push({ label: 'Credit / debit note', icon: 'receipt', run: () => ACT['inv-adjust']({ dataset: { id: i.id } }) });
  if (['Draft', 'Submitted', 'Pending Matching', 'Matching Failed', 'Pending Approval', 'Approved'].includes(i.status) && can('inv.cancel')) more.push({ label: 'Cancel invoice', icon: 'x', danger: true, run: () => ACT['inv-cancel']({ dataset: { id: i.id } }) });
  if (more.length) { ACT['inv-more'] = el => openMenu(el, more); acts.push(`<button class="btn btn-outline btn-sm" style="width:38px;padding:0;height:38px" data-act="inv-more" title="More">${icon('dots', 16)}</button>`); }
  const fails = i.match ? i.match.checks.filter(c => c.status === 'fail') : [];
  return `<div class="page">${pageHead({ title: invRef(i), tags: `${sb(i.status)} ${mb(i.method)}`, right: acts.join(''), crumb: `<a href="#/invoices">Invoice Management</a> / ${esc(invRef(i))}` })}
  ${i.advanceId ? alertBox('info', 'Advance invoice', `This invoice bills advance ${esc(getAdv(i.advanceId).number)} against ${esc(getMS(getAdv(i.advanceId).msId).code)}. It needs no receipt or milestone completion; later milestone invoices recover it automatically.`) : ''}
  <div class="stage ${i.reversed ? 'red' : bn[0] === 'green' ? '' : bn[0]}" style="margin-top:14px"><div class="ico">${icon('receipt', 24, 1.8)}</div><div class="grow"><div class="t">${esc(i.reversed ? 'Reversed via credit note' : bn[1])}</div><div class="hint" style="margin-top:3px">${esc(i.reversed ? `${i.reversed.reason} — ${fmtDT(i.reversed.at)} by ${i.reversed.by}. Allocations were released back to the eligible balance.` : bn[2])}</div></div></div>
  ${apReview(i) ? alertBox('err', 'AP review needed', `A receipt or milestone behind this ${i.status.toLowerCase()} invoice was reversed or reduced after approval: ${money(apReview(i).amount)} of ${esc(apReview(i).refs.join(', '))} is no longer backed. The invoice is preserved; AP decides whether to credit or reverse it.`) : ''}
  <div style="margin-top:18px">${strip([['Base amount', money(i.net)], [`GST (${i.gstRate}%)`, money(i.gst)], ['Total', money(i.gross)], ...(recoveryCash(i) ? [['Advance recovered', '−' + money(recoveryCash(i)), 'net + GST reversed']] : []), ...(damagesCash(i) ? [['Delay damages', '−' + money(damagesCash(i)), (i.damages.items || []).map(x => `${x.code}: ${x.weeks} wk × ${x.ratePct}%`).join(', ')]] : []), ['Payable (after recovery & notes)', money(payable(i)), adj.length ? `${adj.length} note(s)` : ''], ['Matching', i.match ? i.match.result : 'Not run'], ['Approval', approvalStatus(i)], ['Payment', paymentStatus(i)]])}</div>
  <div class="cards-2" style="margin-top:20px;align-items:start">
   <div class="card"><div class="card-t">Invoice details</div><div class="kvg c2">${kv('Reference', invRef(i))}${kv('Bill number', esc(i.number))}${kv('Vendor', `${esc(sup.name)}<div class="hint">${sup.code}</div>`)}${kv('Purchase order', poLink(po))}${kv('Billing method', poMethodBadge(po))}${kv('Bill date', fmtD(i.date))}${kv('Due date', fmtD(i.dueDate))}${kv('Submitted', i.submittedAt ? fmtDT(i.submittedAt) : '—')}${kv('Attachments', attachChips(i.attachments) || '—')}${kv('Remarks', esc(i.remarks) || '—')}${i.ap ? kv('AP voucher', esc(i.ap.voucher) + (i.ap.payRef ? ` · ${esc(i.ap.payRef)}` : '')) : ''}</div>${i.ap ? '<p class="hint" style="margin-top:10px">Simulated AP posting / payment — no ERP or bank system was contacted.</p>' : ''}</div>
   <div class="card"><div class="card-t">What is being invoiced <span class="hint" style="font-weight:400">· ${allocState(i)}</span></div><table class="tbl sm"><thead><tr><th>Source</th><th class="right">Qty</th><th class="right">Value</th><th>State</th></tr></thead><tbody>${i.allocs.map(a => `<tr><td class="strong">${a.kind === 'grn' ? `<a class="link" data-act="rc-open" data-kind="grn" data-id="${a.refId}" href="javascript:void 0">${esc(allocRefLabel(a))}</a>` : a.kind === 'srn' ? `<a class="link" data-act="rc-open" data-kind="srn" data-id="${a.refId}" href="javascript:void 0">${esc(allocRefLabel(a))}</a>` : a.kind === 'milestone' ? `<a class="link" data-act="ms-open" data-id="${a.refId}" href="javascript:void 0">${esc(allocRefLabel(a))}</a>` : a.kind === 'advance' ? `<a class="link" data-act="adv-open" data-id="${a.refId}" href="javascript:void 0">${esc(allocRefLabel(a))} (advance)</a>` : `<a class="link" data-act="claim-open" data-id="${a.refId}" href="javascript:void 0">${esc(allocRefLabel(a))}</a>`}</td><td class="num">${a.qty != null ? fmtNum(a.qty) : '—'}</td><td class="num">${fmtNum(a.value)}</td><td>${sb(allocState(i))}</td></tr>`).join('') || emptyRow(4, 'Standard billing — matched at PO level against accepted receipts.')}${((i.recovery && i.recovery.items) || []).map(x => `<tr><td class="strong"><a class="link" data-act="adv-open" data-id="${x.advId}" href="javascript:void 0">Advance recovered ${esc(x.number)} (${esc(getMS(x.msId).code)})</a></td><td class="num">—</td><td class="num bad-t">−${fmtNum(x.net)}</td><td>${sb(allocState(i))}</td></tr>`).join('')}</tbody></table>
    <p class="hint" style="margin-top:10px">Credit / debit notes are separate records and never restore receipt quantities automatically.</p></div></div>
  ${traceCard(i)}<div class="sec">Matching result ${i.match ? sb(i.match.result) : ''}</div>
  ${i.match ? checksHtml(i.match.checks) : '<div class="empty-state card">Matching has not been run on this invoice.</div>'}
  ${fails.length ? `<div class="sec">How to resolve</div>${fails.map(c => alertBox('err', c.label, `${esc(c.detail)}<div style="margin-top:4px"><b>Action:</b> ${esc(FIX[c.key] || '')}</div>`)).join('')}` : ''}
  ${adj.length ? `<div class="sec">Credit / debit notes</div><div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Type</th><th class="right">Amount</th><th>Reason</th><th>By</th><th>Date</th></tr></thead><tbody>${adj.map(a => `<tr><td>${a.type}</td><td class="num">${fmtNum(a.amount)}</td><td>${esc(a.reason)}</td><td>${esc(a.by)}</td><td>${fmtDT(a.at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  <div class="cards-2" style="align-items:start;margin-top:8px"><div><div class="sec">Status history</div><ul class="tl">${[...i.history].reverse().map(h => `<li class="${['Approved', 'Paid', 'Posted'].includes(h.to) ? 'ok' : ['Rejected', 'Matching Failed', 'Cancelled'].includes(h.to) ? 'bad' : ''}"><div class="tt">${esc(h.from)} → ${esc(h.to)}</div><div class="tm">${esc(h.by)} · ${fmtDT(h.at)}${h.note ? ' — ' + esc(h.note) : ''}</div></li>`).join('') || '<li><div class="tm">No history.</div></li>'}</ul></div>
  <div><div class="sec">Allocation audit</div><ul class="tl">${db.audit.filter(a => a.ref === invRef(i)).map(a => `<li class="${a.kind === 'ok' ? 'ok' : a.kind === 'bad' ? 'bad' : a.kind === 'alloc' ? 'amber' : ''}"><div class="tt">${esc(a.text)}</div><div class="tm">${esc(a.by)} · ${fmtDT(a.at)}</div></li>`).join('') || '<li><div class="tm">No events.</div></li>'}</ul></div></div></div>`;
}
const checksHtml = checks => `<div class="checks">${checks.map(c => `<div class="check ${c.status}"><div class="ci">${icon(c.status === 'pass' ? 'check' : c.status === 'warn' ? 'alert' : c.status === 'fail' ? 'x' : 'info', 12, 3)}</div><div class="cl">${esc(c.label)}</div><div class="cd">${esc(c.detail)}</div></div>`).join('')}</div>`;
const FIX = { adv: 'Recovery is recomputed automatically; re-run matching after the advance or milestone balances change.', po: 'Approve the PO before invoicing.', supplier: 'Create the invoice against the PO of the invoicing vendor.', elig: 'Make sure the receipt / milestone is accepted (and any required GRN / SRN accepted), not fully allocated, then re-run matching.', qty: 'Reduce the invoiced quantity/value to the eligible remaining balance, or wait for further receipts / milestone approval.', dup: 'Use a different bill number, or cancel the earlier invoice if it was submitted in error.', bal: 'Reduce the amount to the remaining PO balance or raise a PO amendment.', gst: 'Correct the GST amount to the PO rate and re-submit.' };
ACT['inv-submit-existing'] = el => { const i = getInv(el.dataset.id); done(A.saveInvoice({ ...i, gstManual: null, attachments: i.attachments, autoMatch: true }, 'submit')); };
ACT['inv-match'] = el => done(A.runMatching(el.dataset.id));
ACT['inv-approve'] = el => reasonModal({ title: 'Approve invoice', label: 'Approval note (optional)', btn: 'Approve', danger: false, ph: 'Optional', optional: true, onSubmit: note => { done(A.approveInvoice(el.dataset.id, note)); } });
ACT['inv-reject'] = el => reasonModal({ title: 'Reject invoice', label: 'Rejection reason', btn: 'Reject invoice', extra: '<p style="margin-bottom:12px">Rejecting releases this invoice\'s reservations so the receipts / milestones can be invoiced again.</p>', onSubmit: reason => { done(A.rejectInvoice(el.dataset.id, reason)); } });
ACT['inv-cancel'] = el => confirmBox({ title: 'Cancel invoice', message: `Cancel <b>${esc(invRef(getInv(el.dataset.id)))}</b>? Its reserved allocations are released.`, confirmLabel: 'Cancel invoice', danger: true, onConfirm: () => done(A.cancelInvoice(el.dataset.id, 'Cancelled by user')) });
ACT['inv-post'] = el => confirmBox({ title: 'Post to AP', message: 'Simulate posting this approved invoice to Accounts Payable? <b>No real accounting entry is created.</b>', confirmLabel: 'Post (simulated)', onConfirm: () => done(A.postInvoice(el.dataset.id)) });
ACT['inv-pay'] = el => confirmBox({ title: 'Mark as paid', message: 'Mark as paid for demo purposes? <b>No bank payment is made.</b>', confirmLabel: 'Mark paid (demo)', onConfirm: () => done(A.payInvoice(el.dataset.id)) });
ACT['inv-reverse'] = el => { const i = getInv(el.dataset.id); reasonModal({ title: `Reverse ${invRef(i)}`, label: 'Reversal reason', btn: 'Reverse invoice', ph: 'e.g. Goods returned, duplicate billing', extra: `<p style="margin-bottom:12px">A full credit note of ${money(payable(i))} is raised and the allocation is <b>released</b> back to the receipt / milestone balance. A credit note on its own never restores eligibility.</p>`, onSubmit: reason => { done(A.reverseInvoice(i.id, reason)); } }); };
/* every invoice line down to the receipt line it consumed (I05–I07), and how the due date splits when several milestones share the invoice (I02) */
function traceCard(i) {
  const rows = (i.allocs || []).some(a => a.trace) ? i.allocs.flatMap(a => a.trace || []) : allocTrace(i), ds = i.dueSplit; if (!rows.length && !ds) return '';
  return `<div class="sec-h" style="margin-top:18px">Allocation trace <span class="hint" style="text-transform:none;font-weight:400;letter-spacing:0">· each line down to the receipt it used — oldest acceptance first${(i.allocs || []).some(a => a.trace) ? ' · locked at submission' : ''}</span></div>
  ${rows.length ? `<div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Milestone</th><th>PO line</th><th>Receipt</th><th>Accepted</th><th class="right">Qty</th><th class="right">Value</th><th>Left on the receipt</th></tr></thead><tbody>${rows.map(r => `<tr><td><b>${esc(r.msCode)}</b></td><td>L${r.lineNo} ${esc(r.line)}</td><td>${r.receipt ? esc(r.receipt) : '<span class="dim-note">approval only</span>'}</td><td>${r.date ? fmtD(r.date) : '—'}</td><td class="num">${r.qty != null ? fmtNum(r.qty) : '—'}</td><td class="num">${fmtNum(r.value)}</td><td>${r.receipt ? (r.partial ? `<span class="badge-s s-amber">${fmtNum(r.left)} still eligible</span>` : '<span class="badge-s s-green">used up</span>') : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${ds ? `<div class="hint" style="margin-top:8px">Several milestones on this invoice — payment is due ${ds.split.length > 1 ? `in ${ds.split.length} parts: ${ds.split.map(x => `${money(x.amount)} on ${fmtD(x.due)}`).join(' · ')}; the invoice carries the earliest date` : `on ${fmtD(ds.earliest)}`}.</div>` : ''}`;
}
ACT['inv-adjust'] = el => { const i = getInv(el.dataset.id); openModal({ title: `Credit / debit note — ${invRef(i)}`, submitLabel: 'Record note', html: `<p style="margin-bottom:12px">Payable now: <b>${money(payable(i))}</b>. Adjustments are separate records — receipt quantities and milestone balances are <b>not</b> restored automatically.</p>${fld('Type', 'type', { opts: ['Credit', 'Debit'], value: el.dataset.type || 'Credit' })}${fld('Amount (INR, incl. GST)', 'amount', { type: 'number', step: 'any', req: true })}${getPO(i.poId).billingMethod === 'Milestone' ? fld('PO amendment version (debit notes only)', 'variationRef', { type: 'number', step: '1', ph: getPO(i.poId).amendments.length ? 'e.g. ' + getPO(i.poId).amendments[0].version : 'needs an approved amendment', hint: 'A debit note or extra invoice for a variation needs an approved PO amendment and never takes the milestone above its amount.' }) : ''}${fld('Reason', 'reason', { rows: 2, req: true })}`, onSubmit: v => { const r = A.addAdjustment(i.id, { type: v.type, amount: +v.amount, reason: v.reason, variationRef: v.variationRef }); if (!r.ok) { toast(r.msg, 'err'); return false; } toast(r.msg); render(); } }); };

/* ================================================================ approvals queue */
ROUTES.approvals = r => {
  const tabs = [['invoices', 'Invoices', db.invoices.filter(i => i.status === 'Pending Approval')], ['pos', 'Purchase Orders', db.pos.filter(p => p.status === 'Pending Approval')],
    ['receipts', 'Receipts', [...db.grns.filter(g => g.status === 'Pending Inspection').map(g => ({ t: 'grn', x: g })), ...db.srns.filter(s => s.status === 'Pending Acceptance').map(s => ({ t: 'srn', x: s }))]],
    ['milestones', 'Milestones', db.milestones.filter(msAwaiting)], ['advances', 'Advances & guarantees', advQueue()], ['claims', 'Progress Claims', db.claims.filter(c => c.status === 'Submitted')]];
  const tab = r.q.tab || (tabs.find(t => t[2].length) || tabs[0])[0], cur = tabs.find(t => t[0] === tab) || tabs[0];
  const body = { invoices: () => `<table class="tbl"><thead><tr><th>Invoice</th><th>Bill No.</th><th>PO</th><th>Billing</th><th class="right">Base</th><th class="right">Total</th><th>Matching</th><th></th></tr></thead><tbody>${cur[2].map(i => `<tr><td class="strong">${invLink(i)}</td><td>${esc(i.number)}</td><td>${esc(getPO(i.poId).number)}</td><td>${mb(i.method)}</td><td class="num">${fmtNum(i.net)}</td><td class="num">${fmtNum(i.gross)}</td><td>${matchBadge(i)}</td><td class="act">${viewBtn(`#/invoice/${i.id}`, 'Review')} ${gbtn('inv.approve', 'inv-reject', 'Reject', { cls: 'btn-danger btn-xs', data: { id: i.id } })} ${gbtn('inv.approve', 'inv-approve', 'Approve', { cls: 'btn-primary btn-xs', data: { id: i.id } })}</td></tr>`).join('') || emptyRow(8, 'No invoices pending approval.')}</tbody></table>`,
    pos: () => `<table class="tbl"><thead><tr><th>PO</th><th>Vendor</th><th>Billing</th><th class="right">Value</th><th></th></tr></thead><tbody>${cur[2].map(p => `<tr><td class="strong">${poLink(p)}<div class="sub">${esc(p.title)}</div></td><td>${esc(getSup(p.supplierId).name)}</td><td>${poMethodBadge(p)}</td><td class="num">${fmtNum(poNet(p))}</td><td class="act">${viewBtn(`#/po/${p.id}`, 'Open')} ${gbtn('po.approve', 'po-reject', 'Reject', { cls: 'btn-danger btn-xs', data: { id: p.id } })} ${gbtn('po.approve', 'po-approve', 'Approve', { cls: 'btn-primary btn-xs', data: { id: p.id } })}</td></tr>`).join('') || emptyRow(5, 'No POs pending approval.')}</tbody></table>`,
    receipts: () => `<table class="tbl"><thead><tr><th>Receipt</th><th>PO</th><th>Type</th><th class="right">Delivered / value</th><th>Status</th><th></th></tr></thead><tbody>${cur[2].map(({ t, x }) => `<tr><td class="strong">${x.number}</td><td>${esc(getPO(x.poId).number)}</td><td>${t.toUpperCase()}</td><td class="num">${t === 'grn' ? fmtNum(x.received) + ' units' : money(x.serviceValue)}</td><td>${sb(x.status)}</td><td class="act"><button class="btn-view" data-act="rc-open" data-kind="${t}" data-id="${x.id}">${icon('open', 12, 2)}Open</button> ${gbtn(t + '.decide', t + '-reject', 'Reject', { cls: 'btn-danger btn-xs', data: { id: x.id } })} ${gbtn(t + '.decide', t + '-accept', 'Accept', { cls: 'btn-primary btn-xs', data: { id: x.id } })}</td></tr>`).join('') || emptyRow(6, 'No receipts awaiting acceptance.')}</tbody></table>`,
    milestones: () => `<table class="tbl"><thead><tr><th>PO</th><th>Milestone</th><th>Submitted</th><th class="right">Amount</th><th>Acceptance</th><th>Status</th><th></th></tr></thead><tbody>${cur[2].map(m => { const po = getPO(m.poId), ag = msAging(m); return `<tr><td>${esc(po.number)}</td><td class="strong">${esc(msFull(m))}</td><td>${m.needsDoc ? `<b>${esc(docTitleOf(m))}</b><div class="sub">` : '<div class="sub">'}${esc(m.submittedBy || '—')} · ${fmtDT(m.submittedAt)}${(m.evidence || []).length ? ` · ${(m.evidence || []).length} file(s)` : ''}</div></td><td class="num">${fmtNum(m.amount)}</td><td>${gateCell(m, po)}</td><td>${sb(m.status)}${ag && ag.level !== 'ok' ? `<div class="sub" style="color:${ag.level === 'escalated' ? 'var(--danger)' : '#8A5A00'};font-weight:600">${ag.level === 'escalated' ? `Escalated to Procurement Manager · ${ag.days}d` : `Reminder sent · waiting ${ag.days}d`}</div>` : ag ? `<div class="sub">Waiting ${ag.days}d</div>` : ''}</td><td class="act"><button class="btn-view" data-act="ms-open" data-id="${m.id}">${icon('open', 12, 2)}Open</button> ${m.status === 'Submitted for Approval' ? gbtn('ms.decide', 'ms-review', 'Start review', { cls: 'btn-outline btn-xs', data: { id: m.id } }) + ' ' : ''}${gbtn('ms.decide', 'ms-info', 'Request info', { cls: 'btn-outline btn-xs', data: { id: m.id } })} ${gbtn('ms.decide', 'ms-reject', 'Reject', { cls: 'btn-danger btn-xs', data: { id: m.id } })} ${gbtn('ms.decide', 'ms-approve', 'Approve', { cls: 'btn-primary btn-xs', data: { id: m.id } })}</td></tr>`; }).join('') || emptyRow(7, 'No milestones awaiting approval.')}</tbody></table>`,
    advances: () => advQueueHtml(cur[2]),
    claims: () => `<table class="tbl"><thead><tr><th>Claim</th><th>PO</th><th>Period</th><th class="right">Current claim</th><th class="right">Cumulative</th><th></th></tr></thead><tbody>${cur[2].map(c => { const v = claimView(c); return `<tr><td class="strong">${c.number}</td><td>${esc(getPO(c.poId).number)}</td><td>${esc(c.period)}</td><td class="num">${fmtNum(v.current)}</td><td class="num">${fmtNum(v.cum)}</td><td class="act"><button class="btn-view" data-act="claim-open" data-id="${c.id}">${icon('open', 12, 2)}Review</button> ${gbtn('claim.decide', 'claim-certify', 'Certify', { cls: 'btn-primary btn-xs', data: { id: c.id } })}</td></tr>`; }).join('') || emptyRow(6, 'No claims awaiting certification.')}</tbody></table>` }[cur[0]];
  return `<div class="page"><h1 class="page-title">Approvals</h1>${tabsHtml(tabs.map(([k, l, a]) => [k, l, a.length]), cur[0], '#/approvals')}<div class="tbl-wrap" style="margin-top:14px">${body()}</div></div>`;
};

/* ================================================================ AP register */
ROUTES.ap = () => {
  const all = db.invoices.filter(i => APPROVED.includes(i.status)), tot = f => sum(all.filter(f), i => payable(i));
  return `<div class="page"><h1 class="page-title">Account Payables</h1>
  <div style="margin-top:16px">${strip([['Approved — not posted', money(tot(i => i.status === 'Approved')), `${all.filter(i => i.status === 'Approved').length} invoice(s)`], ['Posted — awaiting payment', money(tot(i => i.status === 'Posted')), `${all.filter(i => i.status === 'Posted').length} invoice(s)`], ['Paid (demo)', money(tot(i => i.status === 'Paid')), `${all.filter(i => i.status === 'Paid').length} invoice(s)`], ['Total payable', money(tot(() => true))]])}</div>
  ${listHtml('ap', {
    noun: 'invoices', searchPh: 'Search invoice, vendor, PO…',
    tabs: [['all', 'All', () => true], ['approved', 'Not posted', i => i.status === 'Approved'], ['posted', 'Awaiting payment', i => i.status === 'Posted'], ['paid', 'Paid', i => i.status === 'Paid']],
    filters: [{ name: 'method', label: 'Billing', options: () => ['Standard', 'Progressive', 'Milestone'] }, { name: 'supplier', label: 'Vendor', options: () => supOpts() }],
    rows: () => db.invoices.filter(i => APPROVED.includes(i.status)).sort((a, b) => b.seq - a.seq),
    match: (i, st) => matchText(st, invRef(i), i.number, getPO(i.poId).number, getSup(i.supplierId).name) && matchIn(st, 'method', i.method) && matchIn(st, 'supplier', i.supplierId),
    cols: ['Invoice', 'Bill No.', 'PO', 'Vendor', 'Billing', '>Total', '>Payable', 'Payment', ''],
    row: i => `<tr><td class="strong">${invLink(i)}</td><td>${esc(i.number)}</td><td>${esc(getPO(i.poId).number)}</td><td>${esc(getSup(i.supplierId).name)}</td><td>${mb(i.method)}</td><td class="num">${fmtNum(i.gross)}</td><td class="num strong">${fmtNum(payable(i))}</td><td>${sb(paymentStatus(i))}</td><td class="act">${i.status === 'Approved' ? gbtn('inv.post', 'inv-post', 'Post to AP', { cls: 'btn-primary btn-xs', data: { id: i.id } }) : i.status === 'Posted' ? gbtn('inv.post', 'inv-pay', 'Mark paid', { cls: 'btn-primary btn-xs', data: { id: i.id } }) : ''}</td></tr>`,
    empty: 'No approved invoices yet. Approve an invoice to see it here.',
  })}<p class="hint" style="margin-top:12px">Posting and payment are simulated for the demo — no ERP posting, bank payment or vendor notification happens.</p></div>`;
};

/* ================================================================ View Invoice drawer (document on the left, tabs on the right — as in DICE) */
const INR_SYM = n => '₹' + fmtNum(n);
const panOf = g => String(g || '').slice(2, 12);
ACT['inv-view'] = el => openInvoiceView(el.dataset.id);
ACT['iv-tab'] = el => { ui.f.tab = el.dataset.k; render(); };
ACT['iv-chk'] = el => { ui.f.open[el.dataset.k] = !ui.f.open[el.dataset.k]; render(); };
ACT['iv-att'] = () => { ui.f.att = !ui.f.att; render(); };
function openInvoiceView(id) {
  const get = () => getInv(id);
  openPanel({ key: 'iv-' + id, wide: true, bare: true, init: () => ({ tab: 'format', open: { three: true }, att: false }), body: () => invViewBody(get()) });
}
function invDoc(i, po, sup, off) {
  const same = String(sup.gstin).slice(0, 2) === String(off.gstin).slice(0, 2), half = r2(i.gst / 2);
  const rows = i.allocs.map(a => {
    if (a.kind === 'grn') { const g = getGRN(a.refId), l = lineOf(po, g.lineId); return { d: l.desc, ref: `${g.number} · PO ${po.number}`, price: l.price, qty: a.qty, base: a.value }; }
    if (a.kind === 'srn') { const s = getSRN(a.refId); return { d: s.description, ref: `${s.number} · PO ${po.number}`, price: a.value, qty: 1, base: a.value }; }
    if (a.kind === 'milestone') { const m = getMS(a.refId); return { d: m.name, ref: `${m.code} · PO ${po.number}`, price: a.value, qty: 1, base: a.value }; }
    if (a.kind === 'advance') { const x = getAdv(a.refId), m = getMS(x.msId); return { d: `Advance — ${m.code} ${m.name}`, ref: `${x.number} · PO ${po.number}`, price: a.value, qty: 1, base: a.value }; }
    const c = getClaim(a.refId); return { d: `Certified progress — ${c.period}`, ref: `${c.number} · PO ${po.number}`, price: a.value, qty: 1, base: a.value };
  });
  ((i.damages && i.damages.items) || []).forEach(x => rows.push({ d: `Delay damages, ${x.code}`, ref: `${x.lateDays} days late · deducted from payable`, price: -x.amount, qty: 1, base: -x.amount, noTax: true }));
  ((i.recovery && i.recovery.items) || []).forEach(x => rows.push({ d: `Advance recovered, ${getMS(x.msId).code}`, ref: `${x.number} · PO ${po.number}`, price: -x.net, qty: 1, base: -x.net, noTax: poCfg(po).advanceGstMode === 'taxed_at_final' }));
  if (!rows.length) rows.push({ d: isGoods(po) ? 'Goods accepted against the PO' : 'Services accepted against the PO', ref: `PO level · ${po.number}`, price: i.net, qty: 1, base: i.net });
  return `<div class="ivdoc"><div class="ivdoc-top"><span class="chip-e">E-Invoice</span><span class="spacer"></span><span class="hint">Preview Attachments</span><button class="toggle ${ui.f.att ? 'on' : ''}" data-act="iv-att" aria-label="Preview attachments"><i></i></button></div>
    ${ui.f.att ? `<div style="padding:0 0 12px">${attachChips(i.attachments) || '<span class="hint">No attachments</span>'}</div>` : ''}
    <div class="ivdoc-title"><h3>INVOICE</h3><span class="holdchip">${esc(i.status.toUpperCase())}</span></div>
    <div class="ivgrid">
      <div class="ivbox"><div class="ivbox-h">Vendor</div><b>${esc(sup.name)}</b><div class="kvs"><span>Vendor Code:</span> ${esc(sup.code)}<br><span>Email:</span> ${esc(sup.email)}<br><span>GSTIN:</span> ${esc(sup.gstin)}<br><span>PAN:</span> ${esc(panOf(sup.gstin))}<br><span>Mobile:</span> ${esc(sup.mobile)}<br><span>Tax Payer Type:</span> Regular</div></div>
      <div class="ivbox r"><div class="ivbox-h">Invoice Details</div><div class="kvs r"><span>Date:</span> ${fmtD(i.date)}<br><span>Due Date:</span> ${fmtD(i.dueDate)}<br><span>Invoice Number:</span> ${esc(i.number)}<br><span>PO Numbers:</span><br><a class="link" href="#/po/${po.id}">${esc(po.number)}</a></div>
        <div class="amtchip">Amount: <b>${INR_SYM(i.net)}</b></div><div class="amtchip soft">Total Payable Amount: <b>${INR_SYM(payable(i))}</b></div></div>
      <div class="ivbox"><div class="ivbox-h">Billing Address</div><div class="kvs">${esc(off.name)}<br>${esc(off.address)}</div><span class="gstin-chip">GSTIN: ${esc(off.gstin)}</span></div>
      <div class="ivbox r"><div class="ivbox-h">Shipping Address</div><div class="kvs r">${esc(off.name)}<br>${esc(off.address)}</div><span class="gstin-chip">GSTIN: ${esc(off.gstin)}</span></div></div>
    <div class="ivbar">Line Items</div>
    <table class="ivtbl"><thead><tr><th>DESCRIPTION</th><th class="r">PRICE/UNIT</th><th class="r">QTY</th><th class="r">BASE AMT</th><th class="r">TAX %</th><th class="r">TAX AMT</th><th class="r">AMOUNT (INR)</th></tr></thead><tbody>
      ${rows.map((r, n) => `<tr><td>${n + 1}) ${esc(r.d)}<div class="sm">${esc(r.ref)}</div><div class="sm">${isGoods(po) ? 'Goods' : 'Service'}: ${esc(po.category)}</div><div class="sm">Notes: ${esc(po.title)}</div></td><td class="r mono">${fmtNum(r.price)}</td><td class="r">${fmtNum(r.qty)}</td><td class="r mono">${fmtNum(r.base)}</td><td class="r">${r.noTax ? '0.00' : i.gstRate + '.00'}%</td><td class="r mono">${fmtNum(r.noTax ? 0 : r2(r.base * i.gstRate / 100))}</td><td class="r mono">${fmtNum(r.noTax ? r.base : r2(r.base * (100 + i.gstRate) / 100))}</td></tr>`).join('')}</tbody></table>
    <div class="ivbar" style="text-align:center;margin-top:22px">Financial Summary</div>
    <table class="ivsum"><tbody><tr><td>Base Amount:</td><td>${INR_SYM(i.net)}</td></tr><tr><td>SGST / UTGST:</td><td>${INR_SYM(same ? half : 0)}</td></tr><tr><td>CGST:</td><td>${INR_SYM(same ? half : 0)}</td></tr><tr><td>IGST:</td><td>${INR_SYM(same ? 0 : i.gst)}</td></tr><tr><td>Tax Amount:</td><td>${INR_SYM(i.gst)}</td></tr><tr><td>Total Tax Percentage:</td><td>${i.gstRate.toFixed(2)}%</td></tr><tr><td>Cess Amount:</td><td>${INR_SYM(0)}</td></tr><tr><td>Discount Amount:</td><td>${INR_SYM(i.discount || 0)}</td></tr><tr class="g"><td>Total Amount:</td><td>${INR_SYM(i.gross)}</td></tr>${recoveryCash(i) ? `<tr><td>Advance recovered:</td><td>−${INR_SYM(recoveryCash(i))}</td></tr>` : ''}${i.tdsDeducted ? `<tr><td>TDS deducted:</td><td>−${INR_SYM(i.tdsDeducted)}</td></tr>` : ''}${recoveryCash(i) || i.tdsDeducted ? `<tr class="g"><td>Payable:</td><td>${INR_SYM(r2(i.gross - recoveryCash(i) - (i.tdsDeducted || 0)))}</td></tr>` : ''}</tbody></table></div>`;
}
function threeWay(i, po) {
  const rows = i.allocs.map(a => {
    if (a.kind === 'grn') { const g = getGRN(a.refId), l = lineOf(po, g.lineId); return [l.desc, a.qty, l.qty, g.accepted, l.price, l.price]; }
    if (a.kind === 'srn') { const s = getSRN(a.refId); return [s.description, 1, 1, srnEnt(s) >= s.serviceValue - EPS ? 1 : 0, a.value, s.serviceValue]; }
    if (a.kind === 'milestone') { const m = getMS(a.refId), g = msGate(m, po); return [`${m.code} ${m.name}`, 1, 1, !g.required ? '—' : g.ok ? 1 : 0, a.value, m.amount]; }
    if (a.kind === 'advance') { const x = getAdv(a.refId); return [`Advance ${x.number}`, 1, 1, '—', a.value, x.base]; }
    const c = getClaim(a.refId); return [`${c.number} ${c.period}`, 1, 1, '—', a.value, claimView(c).certified];
  });
  const hdr = `<th>#</th><th>TITLE</th><th class="r">INV QTY</th><th class="r">PO QTY</th><th class="r">${isGoods(po) ? 'GRN' : 'SRN'} QTY</th><th class="r">INV PRICE</th><th class="r">PO PRICE</th>`;
  return `<div class="tbl-wrap"><table class="tbl sm"><thead><tr>${hdr}</tr></thead><tbody>${rows.map((r, n) => `<tr><td>${n + 1}</td><td>${esc(r[0])}</td><td class="num">${typeof r[1] === 'number' ? fmtNum(r[1]) : r[1]}</td><td class="num">${fmtNum(r[2])}</td><td class="num ${r[3] === 0 ? 'bad-t' : ''}">${typeof r[3] === 'number' ? fmtNum(r[3]) : r[3]}</td><td class="num">₹${fmtNum(r[4])}</td><td class="num">₹${fmtNum(r[5])}</td></tr>`).join('') || emptyRow(7, 'Standard billing — matched at PO level against the accepted receipts total.')}</tbody></table></div>`;
}
function invViewBody(i) {
  const po = getPO(i.poId), sup = getSup(i.supplierId), off = officeOf(po.office), f = ui.f, adj = adjOf(i);
  const tabs = [['format', 'Format'], ['timeline', 'Timeline'], ['settlement', 'Settlement'], ['cn', 'CN'], ['dn', 'DN'], ['po', 'PO'], ['holds', 'Holds']];
  const fails = i.match ? i.match.checks.filter(c => c.status === 'fail') : [];
  const chkRow = c => `<div class="agent ${f.open[c.key] ? 'open' : ''}"><button class="agent-h" data-act="iv-chk" data-k="${c.key}"><span class="av ${c.status}">${icon(c.status === 'pass' ? 'check' : c.status === 'warn' ? 'alert' : c.status === 'fail' ? 'x' : 'info', 14, 2.6)}</span><span><b>${esc(c.label)}</b><div class="sm">${c.status === 'pass' ? 'Passed' : c.status === 'fail' ? 'Failed' : c.status === 'warn' ? 'Warning' : 'Info'}</div></span><span class="chev">${icon(f.open[c.key] ? 'chevUp' : 'chevDown', 16, 2)}</span></button>${f.open[c.key] ? `<div class="agent-b">${esc(c.detail)}</div>` : ''}</div>`;
  let content = '';
  if (f.tab === 'format') content = `<h3 class="ivh">Matching Summary Timeline</h3>
    ${i.match ? i.match.checks.filter(c => c.key !== 'appr').map(chkRow).join('') : '<div class="hint">Matching has not been run on this invoice yet.</div>'}
    <div class="agent open"><button class="agent-h" data-act="iv-chk" data-k="three"><span class="av pass">${icon('layers', 14, 2)}</span><span><b>Three Way Match <span class="enh">View enhanced data</span></b><div class="sm">${Math.max(i.allocs.length, 1)} item(s)</div></span><span class="chev">${icon(f.open.three ? 'chevUp' : 'chevDown', 16, 2)}</span></button>${f.open.three ? `<div class="agent-b" style="padding:0">${threeWay(i, po)}</div>` : ''}</div>
    <div class="opunit"><span>Operating Unit:</span> ${esc(off.name)}</div>
    ${fails.length ? `<div class="holdbox"><div>${icon('info', 16)}</div><div>This invoice is on hold because of possible reason:<ol>${fails.map(c => `<li><b>${esc(c.label)}</b> — ${esc(c.detail)}</li>`).join('')}</ol></div></div>` : ''}
    <h4 class="ivh2">Requested By</h4><div class="reqby"><span class="avatar-c">${esc(sup.name[0])}</span><b>${esc(sup.name)}</b></div>
    <div class="ivcard"><h4>Invoice Details</h4><div class="kvg c2" style="margin-top:12px">${kv('Category', esc(po.category))}${kv('Amount', fmtNum(i.gross))}${kv('Entity Name', esc(po.buyer))}${kv('Billing method', poMethodBadge(po))}${kv('Bill number', esc(i.number))}${kv('PO', poLink(po))}</div></div>`;
  else if (f.tab === 'timeline') content = `<h3 class="ivh">Timeline</h3><ul class="tl">${[...i.history].reverse().map(h => `<li class="${['Approved', 'Paid', 'Posted'].includes(h.to) ? 'ok' : ['Rejected', 'Matching Failed', 'Cancelled'].includes(h.to) ? 'bad' : ''}"><div class="tt">${esc(h.from)} → ${esc(h.to)}</div><div class="tm">${esc(h.by)} · ${fmtDT(h.at)}${h.note ? ' — ' + esc(h.note) : ''}</div></li>`).join('') || '<li><div class="tm">No history.</div></li>'}</ul><h4 class="ivh2">Allocation audit</h4><ul class="tl">${db.audit.filter(a => a.ref === invRef(i)).map(a => `<li class="${a.kind === 'ok' ? 'ok' : a.kind === 'bad' ? 'bad' : a.kind === 'alloc' ? 'amber' : ''}"><div class="tt">${esc(a.text)}</div><div class="tm">${esc(a.by)} · ${fmtDT(a.at)}</div></li>`).join('')}</ul>`;
  else if (f.tab === 'settlement') content = `<h3 class="ivh">Settlement</h3>${strip([['Total', money(i.gross)], ['Credit notes', money(sum(adj.filter(a => a.type === 'Credit'), a => a.amount))], ['Debit notes', money(sum(adj.filter(a => a.type === 'Debit'), a => a.amount))], ['Payable', money(payable(i)), '', 'hl']])}<div class="kvg c2" style="margin-top:18px">${kv('Approval', approvalStatus(i))}${kv('Payment', paymentStatus(i))}${kv('AP voucher', i.ap ? esc(i.ap.voucher) : '—')}${kv('Payment reference', i.ap?.payRef ? esc(i.ap.payRef) : '—')}</div><p class="hint" style="margin-top:12px">Posting and payment are simulated — no ERP or bank is contacted.</p>`;
  else if (f.tab === 'cn' || f.tab === 'dn') { const t = f.tab === 'cn' ? 'Credit' : 'Debit', l = adj.filter(a => a.type === t);
    content = `<h3 class="ivh">${t} notes</h3><div class="tbl-wrap"><table class="tbl sm"><thead><tr><th>Date</th><th class="right">Amount</th><th>Reason</th><th>By</th></tr></thead><tbody>${l.map(a => `<tr><td>${fmtD(a.at)}</td><td class="num">${fmtNum(a.amount)}</td><td>${esc(a.reason)}</td><td>${esc(a.by)}</td></tr>`).join('') || emptyRow(4, `No ${t.toLowerCase()} notes recorded.`)}</tbody></table></div><p class="hint" style="margin:12px 0">Notes are separate records — they never restore receipt quantities or milestone balances.</p>${APPROVED.includes(i.status) ? gbtn('inv.adjust', 'inv-adjust', `Add ${t.toLowerCase()} note`, { data: { id: i.id, type: t }, icn: 'plus' }) : '<span class="hint">Notes can be added once the invoice is approved.</span>'}`; }
  else if (f.tab === 'po') { const s = poSummary(po); content = `<h3 class="ivh">Purchase order</h3><div class="kvg c2">${kv('PO', poLink(po))}${kv('Title', esc(po.title))}${kv('Billing', poMethodBadge(po))}${kv('Stage', stagePill(po))}</div><div style="margin-top:16px">${strip([['PO value', money(s.value)], ['Accepted', money(s.accepted)], ['Invoiced', money(s.invoiced)], ['Ready to invoice', money(s.remaining), '', 'hl']])}</div>`; }
  else content = `<h3 class="ivh">Holds</h3>${fails.length ? fails.map(c => alertBox('err', c.label, `${esc(c.detail)}<div style="margin-top:4px"><b>Action:</b> ${esc(FIX[c.key] || '')}</div>`)).join('') : alertBox('ok', 'No holds', 'This invoice has no matching exceptions.')}`;
  const acts = [];
  if (['Draft', 'Matching Failed'].includes(i.status)) acts.push(gbtn('inv.create', 'inv-edit', 'Edit', { icn: 'edit', data: { id: i.id }, cls: 'btn-outline' }));
  if (i.status === 'Draft') acts.push(gbtn('inv.create', 'inv-submit-existing', 'Submit Invoice', { cls: 'btn-primary', data: { id: i.id }, icn: 'check' }));
  if (['Submitted', 'Pending Matching', 'Matching Failed', 'Pending Approval'].includes(i.status)) acts.push(gbtn('inv.match', 'inv-match', 'Re-run matching', { cls: 'btn-outline', data: { id: i.id }, icn: 'play' }));
  if (i.status === 'Pending Approval') acts.push(gbtn('inv.approve', 'inv-reject', 'Reject', { cls: 'btn-danger', data: { id: i.id } }), gbtn('inv.approve', 'inv-approve', 'Approve', { cls: 'btn-primary', data: { id: i.id }, icn: 'check' }));
  if (i.status === 'Approved') acts.push(gbtn('inv.post', 'inv-post', 'Post to AP', { cls: 'btn-primary', data: { id: i.id } }));
  if (i.status === 'Posted') acts.push(gbtn('inv.post', 'inv-pay', 'Mark as Paid (demo)', { cls: 'btn-primary', data: { id: i.id } }));
  return `<div class="panel-split iv"><div class="pv">${invDoc(i, po, sup, off)}</div><div class="fm ivfm">
    <div class="ivhead"><button class="x-btn" data-act="panel-close" title="Close">${icon('x', 22, 2)}</button><h2>${esc(invRef(i))}</h2><div class="sub">Bill no. ${esc(i.number)} · ${sb(i.status)} <a class="link" href="#/invoice/${i.id}" style="margin-left:8px">Open full page</a></div></div>
    <div class="ivtabs">${tabs.map(([k, l]) => `<button class="${f.tab === k ? 'on' : ''}" data-act="iv-tab" data-k="${k}">${l}${k === 'holds' && fails.length ? `<span class="dotbad"></span>` : ''}</button>`).join('')}</div>
    <div class="ivbody">${content}</div>${acts.length ? `<div class="ivfoot">${acts.join('')}</div>` : ''}</div></div>`;
}
