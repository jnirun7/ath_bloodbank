// แดชบอร์ดเจ้าหน้าที่: ล็อกอินด้วย Supabase Auth, สิทธิ์ควบคุมด้วย RLS ฝั่งฐานข้อมูล
// (หน้านี้ใช้ anon key เท่านั้น - ถ้าไม่ใช่ผู้ใช้ใน admin_users จะอ่าน/เขียนข้อมูลไม่ได้)
(() => {
  'use strict';
  const C = window.CONFIG;
  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const root = document.getElementById('root');

  const S = { me: null, tab: 'bookings', view: 'week', date: bkkToday(), year: new Date().getFullYear() };
  const TABS = [['bookings', 'รายการจอง'], ['holidays', 'วันหยุด'], ['slots', 'ช่วงเวลา/ขีดจำกัดคิว'],
                ['stats', 'สถิติ'], ['search', 'ค้นหาผู้บริจาค'], ['channels', 'ห้องแจ้งเตือน (หมอพร้อม)'], ['settings', 'แจ้งเตือนผู้บริจาค (LINE)']];
  const STATUS = { pending: ['รอยืนยัน', 'warn'], completed: ['มาบริจาคสำเร็จ', 'ok'], cancelled: ['ยกเลิก', 'bad'], no_show: ['ไม่มา', 'bad'] };
  const EVENTS = [['booking_created', 'จองใหม่'], ['booking_cancelled', 'ยกเลิกจอง'], ['daily_summary', 'สรุปนัดพรุ่งนี้']];

  // ---------- helpers ----------
  function bkkToday() { return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (d, o) => new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', { timeZone: 'UTC', ...o });
  const $ = (id) => document.getElementById(id);
  const msg = (t, err) => { const m = $('msg'); if (m) m.innerHTML = t ? `<div class="msg ${err ? 'err' : ''}">${esc(t)}</div>` : ''; };
  const fail = (e) => msg(e?.message || String(e), true);

  // ---------- login ----------
  async function boot() {
    const { data } = await sb.auth.getSession();
    data.session ? await enter() : loginView();
  }

  function loginView(note) {
    root.innerHTML = `<div class="card login"><h2>เข้าสู่ระบบเจ้าหน้าที่</h2><p class="mute">ธนาคารเลือด โรงพยาบาลอ่างทอง</p>
      ${note ? `<div class="msg err">${esc(note)}</div>` : ''}
      <input id="em" type="email" placeholder="อีเมล" autocomplete="username">
      <input id="pw" type="password" placeholder="รหัสผ่าน" autocomplete="current-password">
      <button class="btn" id="login" style="width:100%">เข้าสู่ระบบ</button></div>`;
    $('login').onclick = async () => {
      const { error } = await sb.auth.signInWithPassword({ email: $('em').value.trim(), password: $('pw').value });
      if (error) return loginView('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      await enter();
    };
    $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login').click(); });
  }

  async function enter() {
    const { data: u } = await sb.auth.getUser();
    const { data: adm } = await sb.from('admin_users').select('display_name, role').eq('user_id', u.user.id).maybeSingle();
    if (!adm) { await sb.auth.signOut(); return loginView('บัญชีนี้ยังไม่ได้รับสิทธิ์เจ้าหน้าที่ กรุณาติดต่อผู้ดูแลระบบ'); }
    S.me = adm;
    shell();
  }

  function shell() {
    const tabs = TABS.filter(([k]) => !['channels', 'settings'].includes(k) || S.me.role === 'admin');
    root.innerHTML = `
      <header><div><b>🩸 ธนาคารเลือด รพ.อ่างทอง</b><br><small>${esc(S.me.display_name)} (${S.me.role === 'admin' ? 'ผู้ดูแล' : 'เจ้าหน้าที่'})</small></div>
        <button class="btn sec sm" id="logoutbtn" style="background:#fff">ออกจากระบบ</button></header>
      <nav>${tabs.map(([k, t]) => `<button data-t="${k}" class="${S.tab === k ? 'on' : ''}">${t}</button>`).join('')}</nav>
      <main><div id="msg"></div><div id="view"></div></main>`;
    $('logoutbtn').onclick = async () => { await sb.auth.signOut(); loginView(); };
    document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { S.tab = b.dataset.t; shell(); }));
    ({ bookings, holidays, slots, stats, search, channels, settings })[S.tab]();
  }

  // ---------- 1) รายการจอง: รายสัปดาห์ (ภาพรวม) / รายวัน (เปลี่ยนสถานะ) ----------
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const mondayOf = (iso) => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const ACTIVE = ['pending', 'completed'];                 // นับเป็นคิวที่ใช้ที่นั่งจริง (เหมือนกติกาจองในฐานข้อมูล)

  // ดึงชื่อผู้ใช้แยกคำสั่ง (ไม่ใช้การ join ในคำสั่งเดียว)
  async function loadUsers(rows) {
    const ids = [...new Set(rows.map((r) => r.user_id))];
    if (!ids.length) return new Map();
    const { data, error } = await sb.from('users').select('id, full_name, phone, display_name').in('id', ids);
    if (error) throw error;
    return new Map(data.map((u) => [u.id, u]));
  }

  function bookings() {
    S.view = S.view || 'week';
    $('view').innerHTML = `<div class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0;flex:1">รายการจอง</h2>
        <button class="btn sm ${S.view === 'week' ? '' : 'sec'}" id="vw">รายสัปดาห์</button>
        <button class="btn sm ${S.view === 'day' ? '' : 'sec'}" id="vd">รายวัน</button></div>
      <div id="bk"></div></div>`;
    $('vw').onclick = () => { S.view = 'week'; bookings(); };
    $('vd').onclick = () => { S.view = 'day'; bookings(); };
    (S.view === 'week' ? weekView : dayView)().catch(fail);
  }

  async function weekView() {
    const mon = mondayOf(S.date), fri = addDays(mon, 4);
    const days = [0, 1, 2, 3, 4].map((n) => addDays(mon, n));
    $('bk').innerHTML = `<div class="row">
        <button class="btn sec sm" id="pw">◀ สัปดาห์ก่อน</button>
        <b id="wtitle" style="min-width:210px;text-align:center"></b>
        <button class="btn sec sm" id="nw">สัปดาห์ถัดไป ▶</button>
        <button class="btn sec sm" id="tw">สัปดาห์นี้</button>
        <input type="date" id="jd" value="${S.date}" title="ไปยังสัปดาห์ที่มีวันที่นี้"></div>
      <div id="wk" class="mute">กำลังโหลด...</div>`;
    $('pw').onclick = () => { S.date = addDays(mon, -7); bookings(); };
    $('nw').onclick = () => { S.date = addDays(mon, 7); bookings(); };
    $('tw').onclick = () => { S.date = bkkToday(); bookings(); };
    $('jd').onchange = () => { if ($('jd').value) { S.date = $('jd').value; bookings(); } };
    $('wtitle').textContent = `${fmt(mon, { day: 'numeric', month: 'short' })} - ${fmt(fri, { day: 'numeric', month: 'short', year: 'numeric' })}`;

    const [slotsR, bkR, holR] = await Promise.all([
      sb.from('time_slots').select('id, label, max_capacity, is_active, start_time').order('start_time'),
      sb.from('bookings').select('id, user_id, booking_date, time_slot_id, status').gte('booking_date', mon).lte('booking_date', fri),
      sb.from('hospital_holidays').select('holiday_date, name').gte('holiday_date', mon).lte('holiday_date', fri),
    ]);
    for (const r of [slotsR, bkR, holR]) if (r.error) throw r.error;
    const users = await loadUsers(bkR.data);
    const hol = Object.fromEntries(holR.data.map((h) => [h.holiday_date, h.name]));
    const today = bkkToday();
    const nameOf = (b) => users.get(b.user_id)?.full_name || users.get(b.user_id)?.display_name || '(ไม่ระบุ)';

    let html = '<div class="wkwrap"><table class="wk"><tr><th class="slt"></th>';
    for (const d of days) {
      html += `<th class="${d === today ? 'today' : ''} ${hol[d] ? 'hol' : ''}"><a href="#" data-day="${d}" title="ดู/เปลี่ยนสถานะรายวัน">${esc(fmt(d, { weekday: 'short' }))} ${esc(fmt(d, { day: 'numeric' }))}<br><small>${esc(fmt(d, { month: 'short' }))}</small></a>${hol[d] ? `<br><small>${esc(hol[d])}</small>` : ''}</th>`;
    }
    html += '</tr>';
    const dayTotals = Object.fromEntries(days.map((d) => [d, { used: 0, cap: 0 }]));
    for (const s of slotsR.data) {
      html += `<tr><th class="slt">${esc(s.label)}${s.is_active ? '' : '<br><small>(ปิด)</small>'}</th>`;
      for (const d of days) {
        const list = bkR.data.filter((b) => b.booking_date === d && b.time_slot_id === s.id && b.status !== 'cancelled');
        const used = list.filter((b) => ACTIVE.includes(b.status)).length;
        if (hol[d]) {
          // วันหยุดที่ยังมีคิวค้าง (จองไว้ก่อนเพิ่มวันหยุด) ต้องแสดงให้เจ้าหน้าที่เห็นและจัดการ
          dayTotals[d].used += used;
          html += list.length
            ? `<td class="hol"><div class="cnt">⚠ ${used} คิวค้าง</div>${list.map((b) => `<div class="nm ${b.status}">${esc(nameOf(b))}</div>`).join('')}</td>`
            : '<td class="hol">หยุด</td>';
          continue;
        }
        if (!s.is_active) { html += '<td class="off">-</td>'; continue; }
        dayTotals[d].used += used; dayTotals[d].cap += s.max_capacity;
        const cls = used >= s.max_capacity ? 'full' : used > 0 ? 'some' : 'empty';
        html += `<td class="${cls} ${d === today ? 'today' : ''}"><div class="cnt">${used}/${s.max_capacity}</div>` +
          list.map((b) => `<div class="nm ${b.status}" title="${esc(STATUS[b.status][0])}">${esc(nameOf(b))}${b.status === 'completed' ? ' ✓' : b.status === 'no_show' ? ' ✗' : ''}</div>`).join('') + '</td>';
      }
      html += '</tr>';
    }
    html += '<tr class="tot"><th class="slt">รวมต่อวัน</th>' +
      days.map((d) => (hol[d] ? `<td class="hol">${dayTotals[d].used ? '⚠ ' + dayTotals[d].used + ' คิวค้าง' : '-'}</td>` : `<td><b>${dayTotals[d].used}</b> / ${dayTotals[d].cap}</td>`)).join('') + '</tr></table></div>';

    const usedAll = Object.values(dayTotals).reduce((a, t) => a + t.used, 0), capAll = Object.values(dayTotals).reduce((a, t) => a + t.cap, 0);
    $('wk').className = '';
    $('wk').innerHTML = `<p style="margin:4px 0 10px"><b>สัปดาห์นี้จอง ${usedAll} คิว</b> จากที่รับได้ ${capAll} คิว (ว่าง ${capAll - usedAll})</p>${html}
      <p class="mute" style="margin-top:8px"><span class="lg full"></span>เต็ม <span class="lg some"></span>มีผู้จอง <span class="lg empty"></span>ว่าง <span class="lg hol"></span>วันหยุด
      · ✓ = บริจาคสำเร็จ · ✗ = ไม่มา · คิวที่ยกเลิกไม่แสดง · กดที่หัววันเพื่อเปลี่ยนสถานะรายวัน</p>`;
    document.querySelectorAll('[data-day]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.date = a.dataset.day; S.view = 'day'; bookings(); }));
  }

  async function dayView() {
    $('bk').innerHTML = `<div class="row"><input type="date" id="d" value="${S.date}">
        <button class="btn sec sm" id="prev">◀ วันก่อน</button><button class="btn sec sm" id="next">วันถัดไป ▶</button>
        <button class="btn sec sm" id="today">วันนี้</button></div>
      <div id="list" class="mute">กำลังโหลด...</div>`;
    $('d').onchange = () => { S.date = $('d').value; bookings(); };
    const shift = (n) => { S.date = addDays(S.date, n); bookings(); };
    $('prev').onclick = () => shift(-1); $('next').onclick = () => shift(1);
    $('today').onclick = () => { S.date = bkkToday(); bookings(); };

    const [slotsR, bkR] = await Promise.all([
      sb.from('time_slots').select('id, label').order('start_time'),
      sb.from('bookings').select('id, user_id, status, time_slot_id').eq('booking_date', S.date),
    ]);
    for (const r of [slotsR, bkR]) if (r.error) throw r.error;
    const longDate = fmt(S.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!bkR.data.length) { $('list').textContent = `ไม่มีรายการจองวัน${longDate}`; return; }
    const users = await loadUsers(bkR.data);

    const counts = bkR.data.reduce((a, b) => (a[b.status] = (a[b.status] || 0) + 1, a), {});
    let html = `<p class="mute">${esc(longDate)} · รวม ${bkR.data.length} คิว
      (รอ ${counts.pending || 0} · สำเร็จ ${counts.completed || 0} · ไม่มา ${counts.no_show || 0} · ยกเลิก ${counts.cancelled || 0})</p>
      <table><tr><th>ชื่อ-นามสกุล</th><th>เบอร์โทร</th><th>สถานะ</th><th>เปลี่ยนสถานะ</th></tr>`;
    for (const s of slotsR.data) {
      const list = bkR.data.filter((b) => b.time_slot_id === s.id);
      if (!list.length) continue;
      html += `<tr><td colspan="4" class="slotname">${esc(s.label)} น.</td></tr>`;
      for (const b of list) {
        const u = users.get(b.user_id); const [t, c] = STATUS[b.status];
        html += `<tr><td>${esc(u?.full_name || u?.display_name || '(ไม่ระบุ)')}</td><td>${esc(u?.phone || '-')}</td>
          <td><span class="tag ${c}">${t}</span></td>
          <td><select data-id="${b.id}" data-cur="${b.status}">${Object.entries(STATUS).map(([k, [n]]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${n}</option>`).join('')}</select></td></tr>`;
      }
    }
    $('list').className = '';
    $('list').innerHTML = html + '</table>';
    document.querySelectorAll('#list select').forEach((sel) => (sel.onchange = async () => {
      if (sel.value === 'completed' && !confirm('ยืนยัน "มาบริจาคสำเร็จ"? ระบบจะสร้างประวัติและเลขใบเกียรติบัตรให้ผู้บริจาค')) { sel.value = sel.dataset.cur; return; }
      const { error } = await sb.from('bookings').update({ status: sel.value }).eq('id', sel.dataset.id);
      if (error) { sel.value = sel.dataset.cur; return fail(error); }
      msg('อัปเดตสถานะแล้ว'); bookings();
    }));
  }

  // ---------- 2) วันหยุด ----------
  async function holidays() {
    $('view').innerHTML = `<div class="card"><h2>วันหยุดราชการ/วันหยุดโรงพยาบาล</h2>
      <p class="mute">เสาร์-อาทิตย์ปิดอัตโนมัติ ไม่ต้องเพิ่มที่นี่ · วันที่เพิ่มจะปิดรับจองทันที (ไม่ยกเลิกคิวที่จองไว้แล้ว)</p>
      <div class="row"><input type="date" id="hd"><input id="hn" placeholder="ชื่อวันหยุด" style="min-width:220px"><button class="btn" id="add">เพิ่ม</button></div>
      <div id="list" class="mute">กำลังโหลด...</div></div>`;
    $('add').onclick = async () => {
      if (!$('hd').value || !$('hn').value.trim()) return msg('กรอกวันที่และชื่อวันหยุด', true);
      const { error } = await sb.from('hospital_holidays').insert({ holiday_date: $('hd').value, name: $('hn').value.trim() });
      if (error) return fail(error.code === '23505' ? { message: 'มีวันหยุดวันนี้แล้ว' } : error);
      msg('เพิ่มวันหยุดแล้ว'); holidays();
    };
    const { data, error } = await sb.from('hospital_holidays').select('*').gte('holiday_date', bkkToday()).order('holiday_date');
    if (error) return fail(error);
    $('list').innerHTML = data.length
      ? `<table><tr><th>วันที่</th><th>ชื่อ</th><th></th></tr>${data.map((h) => `<tr><td>${esc(fmt(h.holiday_date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }))}</td><td>${esc(h.name)}</td>
          <td><button class="btn sec sm" data-d="${h.holiday_date}">ลบ</button></td></tr>`).join('')}</table>`
      : 'ยังไม่มีวันหยุดที่กำหนดไว้ล่วงหน้า';
    document.querySelectorAll('#list button').forEach((b) => (b.onclick = async () => {
      if (!confirm('ลบวันหยุดนี้?')) return;
      const { error } = await sb.from('hospital_holidays').delete().eq('holiday_date', b.dataset.d);
      error ? fail(error) : (msg('ลบแล้ว'), holidays());
    }));
  }

  // ---------- 3) ช่วงเวลา/ขีดจำกัดคิว ----------
  async function slots() {
    const { data, error } = await sb.from('time_slots').select('*').order('start_time');
    if (error) return fail(error);
    $('view').innerHTML = `<div class="card"><h2>ขีดจำกัดคิวต่อช่วงเวลา</h2>
      <p class="mute">ตั้งเป็น 0 หรือปิดใช้งานเพื่อหยุดรับจองช่วงนั้น · มีผลกับการจองใหม่ (คิวเดิมไม่ถูกยกเลิก)</p>
      <table><tr><th>ช่วงเวลา</th><th>รับได้ (คน)</th><th>เปิดใช้งาน</th><th></th></tr>
      ${data.map((s) => `<tr><td>${esc(s.label)} น.</td><td><input type="number" min="0" max="50" id="c${s.id}" value="${s.max_capacity}"></td>
        <td><input type="checkbox" id="a${s.id}" ${s.is_active ? 'checked' : ''}></td>
        <td><button class="btn sm" data-id="${s.id}">บันทึก</button></td></tr>`).join('')}</table></div>`;
    document.querySelectorAll('#view button[data-id]').forEach((b) => (b.onclick = async () => {
      const id = b.dataset.id; const cap = Number($('c' + id).value);
      if (!Number.isInteger(cap) || cap < 0 || cap > 50) return msg('จำนวนต้องเป็นเลข 0-50', true);
      const { error } = await sb.from('time_slots').update({ max_capacity: cap, is_active: $('a' + id).checked }).eq('id', id);
      error ? fail(error) : msg('บันทึกแล้ว');
    }));
  }

  // ---------- 4) สถิติ ----------
  async function stats() {
    $('view').innerHTML = `<div class="card"><h2>สถิติการจองและการบริจาค</h2>
      <div class="row"><label>ปี (ค.ศ.) <input type="number" id="y" value="${S.year ?? ''}" min="2020" max="2100" placeholder="ทุกปี"></label>
        <button class="btn sec sm" id="allyears">ทุกปี</button><button class="btn sm" id="showstats">ดู</button></div>
      <div id="statsbox" class="mute">กำลังโหลด...</div></div>`;
    $('showstats').onclick = () => { S.year = Number($('y').value) || null; stats(); };
    $('allyears').onclick = () => { S.year = null; stats(); };
    const { data, error } = await sb.rpc('stats_monthly', { p_year: S.year });
    if (error) return fail(error);
    const box = $('statsbox'); box.className = '';
    if (!data.length) { box.innerHTML = '<p class="mute">ไม่มีข้อมูลในช่วงที่เลือก</p>'; return; }
    const max = Math.max(...data.map((r) => r.booked), 1);
    const tot = data.reduce((a, r) => ({ b: a.b + r.booked, c: a.c + r.completed, x: a.x + r.cancelled, n: a.n + r.no_show }), { b: 0, c: 0, x: 0, n: 0 });
    const tile = (label, v, cls) => `<div class="kpi ${cls}"><div class="kv">${v}</div><div class="kl">${label}</div></div>`;
    box.innerHTML = `
      <div class="kpis">${tile('จองทั้งหมด', tot.b, '')}${tile('บริจาคสำเร็จ', tot.c, 'ok')}${tile('ยกเลิก', tot.x, 'bad')}${tile('ไม่มา', tot.n, 'warn')}</div>
      <h3>แยกรายเดือน</h3>
      <div class="tblwrap"><table><tr><th>เดือน</th><th>จอง</th><th>บริจาคสำเร็จ</th><th>ยกเลิก</th><th>ไม่มา</th><th style="min-width:140px">กราฟ</th></tr>
      ${data.map((r) => `<tr><td>${esc(fmt(r.month, { month: 'long', year: 'numeric' }))}</td><td>${r.booked}</td><td>${r.completed}</td><td>${r.cancelled}</td><td>${r.no_show}</td>
        <td><div class="bar" style="width:${(r.booked / max) * 100}%"></div><div class="bar g" style="width:${(r.completed / max) * 100}%;margin-top:2px"></div></td></tr>`).join('')}</table></div>
      <p class="mute" style="margin-top:8px">แถบแดง = จอง · แถบเขียว = บริจาคสำเร็จ</p>`;
  }

  // ---------- 5) ค้นหาผู้บริจาค ----------
  function search() {
    $('view').innerHTML = `<div class="card"><h2>ค้นหาผู้บริจาค</h2>
      <div class="row"><input id="q" placeholder="ชื่อ-นามสกุล หรือ LINE User ID" style="min-width:280px"><button class="btn" id="go">ค้นหา</button></div>
      <div id="res" class="mute">พิมพ์อย่างน้อย 2 ตัวอักษร</div></div><div id="detail"></div>`;
    const run = async () => {
      // ตัดอักขระที่มีความหมายใน PostgREST filter ออก
      const q = $('q').value.trim().replace(/[,()%*\\]/g, '');
      if (q.length < 2) return msg('พิมพ์อย่างน้อย 2 ตัวอักษร', true);
      msg('');
      const { data, error } = await sb.from('users').select('id, full_name, phone, display_name, line_user_id, created_at')
        .is('deleted_at', null).or(`full_name.ilike.%${q}%,line_user_id.ilike.%${q}%,display_name.ilike.%${q}%`).limit(30);
      if (error) return fail(error);
      $('res').innerHTML = data.length
        ? `<table><tr><th>ชื่อ-นามสกุล</th><th>ชื่อใน LINE</th><th>เบอร์โทร</th><th></th></tr>${data.map((u) => `<tr><td>${esc(u.full_name || '-')}</td><td>${esc(u.display_name || '-')}</td><td>${esc(u.phone || '-')}</td>
            <td><button class="btn sec sm" data-u="${u.id}">ดูประวัติ</button></td></tr>`).join('')}</table>` : 'ไม่พบข้อมูล';
      document.querySelectorAll('#res button').forEach((b) => (b.onclick = () => detail(data.find((u) => u.id === b.dataset.u))));
    };
    $('go').onclick = run; $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  async function detail(u) {
    const [{ data: bk }, { data: dn }] = await Promise.all([
      sb.from('bookings').select('booking_date, status, time_slots(label)').eq('user_id', u.id).order('booking_date', { ascending: false }).limit(30),
      sb.from('donation_records').select('donated_on, certificate_no').eq('user_id', u.id).order('donated_on', { ascending: false }),
    ]);
    $('detail').innerHTML = `<div class="card"><h2>${esc(u.full_name || u.display_name || '-')}</h2>
      <p class="mute">โทร ${esc(u.phone || '-')} · LINE ID: ${esc(u.line_user_id)}</p>
      <h3>ประวัติการบริจาค (${dn?.length || 0} ครั้ง)</h3>
      ${dn?.length ? `<table>${dn.map((d) => `<tr><td>${esc(fmt(d.donated_on, { day: 'numeric', month: 'long', year: 'numeric' }))}</td><td>${esc(d.certificate_no)}</td></tr>`).join('')}</table>` : '<p class="mute">ยังไม่มี</p>'}
      <h3>ประวัติการจอง</h3>
      ${bk?.length ? `<table>${bk.map((b) => { const [t, c] = STATUS[b.status]; return `<tr><td>${esc(fmt(b.booking_date, { day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${esc(b.time_slots?.label)} น.</td><td><span class="tag ${c}">${t}</span></td></tr>`; }).join('')}</table>` : '<p class="mute">ยังไม่มี</p>'}
      <p class="mute">ผลคัดกรองสุขภาพออนไลน์ไม่แสดงให้เจ้าหน้าที่ (ลดการเข้าถึงข้อมูลสุขภาพตาม PDPA) — ตรวจจริงที่โรงพยาบาล</p></div>`;
    $('detail').scrollIntoView({ behavior: 'smooth' });
  }

  // ---------- 6) ห้องแจ้งเตือน MOPH Notify (เฉพาะ admin) ----------
  async function channels() {
    // ห้ามใช้ select('*') เพราะ secret_key ถูกปิดอ่านจากเบราว์เซอร์
    const { data, error } = await sb.from('notify_channels').select('id, name, client_key, event_types, is_active').order('id');
    if (error) return fail(error);
    $('view').innerHTML = `
      <div class="card"><h2>ห้องแจ้งเตือนเจ้าหน้าที่ (MOPH Notify / หมอพร้อม)</h2>
        <p class="mute">เลือกได้ว่าแต่ละห้องรับเหตุการณ์ใด · ข้อความที่ส่งเข้าห้องไม่มีชื่อผู้บริจาค · Secret Key บันทึกแล้วจะไม่แสดงกลับ</p>
        ${data.length ? `<table><tr><th>ชื่อห้อง</th><th>Client ID</th><th>เหตุการณ์ที่แจ้ง</th><th>ใช้งาน</th><th></th></tr>
          ${data.map((c) => `<tr><td>${esc(c.name)}</td><td class="mute">${esc(c.client_key.slice(0, 8))}…</td>
            <td>${EVENTS.map(([k, t]) => `<label class="ck"><input type="checkbox" data-ev="${c.id}" value="${k}" ${c.event_types.includes(k) ? 'checked' : ''}>${t}</label>`).join('')}</td>
            <td><input type="checkbox" data-act="${c.id}" ${c.is_active ? 'checked' : ''}></td>
            <td><button class="btn sm" data-save="${c.id}">บันทึก</button> <button class="btn sec sm" data-test="${c.id}">ทดสอบส่ง</button> <button class="btn sec sm" data-del="${c.id}">ลบ</button></td></tr>`).join('')}</table>`
          : '<p class="mute">ยังไม่มีห้อง</p>'}</div>
      <div class="card"><h2>เพิ่มห้องใหม่</h2>
        <p class="mute">ขั้นตอน: ตั้งชื่อกลุ่ม LINE ให้ลงท้าย HC + รหัสหน่วยบริการ 5 หลัก → เชิญ "หมอพร้อม" → admin อนุมัติใน CMS MOPH Notify → นำ Client ID / Secret มากรอก</p>
        <div class="row"><input id="nn" placeholder="ชื่อห้อง"><input id="nk" placeholder="Client ID" autocomplete="off"><input id="ns" type="password" placeholder="Secret Key" autocomplete="off"></div>
        <div class="row">${EVENTS.map(([k, t]) => `<label class="ck"><input type="checkbox" class="nev" value="${k}" checked>${t}</label>`).join('')}<button class="btn" id="add">เพิ่มห้อง</button></div></div>`;

    $('add').onclick = async () => {
      const name = $('nn').value.trim(), key = $('nk').value.trim(), sec = $('ns').value.trim();
      if (!name || !key || !sec) return msg('กรอกชื่อห้อง Client ID และ Secret Key ให้ครบ', true);
      const ev = [...document.querySelectorAll('.nev:checked')].map((x) => x.value);
      const { error } = await sb.from('notify_channels').insert({ name, client_key: key, secret_key: sec, event_types: ev });
      error ? fail(error) : (msg('เพิ่มห้องแล้ว — กด "ทดสอบส่ง" เพื่อตรวจว่าใช้งานได้'), channels());
    };
    document.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
      const id = b.dataset.save;
      const ev = [...document.querySelectorAll(`[data-ev="${id}"]:checked`)].map((x) => x.value);
      const { error } = await sb.from('notify_channels').update({ event_types: ev, is_active: document.querySelector(`[data-act="${id}"]`).checked }).eq('id', id);
      error ? fail(error) : msg('บันทึกแล้ว');
    }));
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!confirm('ลบห้องนี้?')) return;
      const { error } = await sb.from('notify_channels').delete().eq('id', b.dataset.del);
      error ? fail(error) : (msg('ลบแล้ว'), channels());
    }));
    document.querySelectorAll('[data-test]').forEach((b) => (b.onclick = async () => {
      b.disabled = true; msg('กำลังส่งข้อความทดสอบ...');
      try {
        const { data: s } = await sb.auth.getSession();
        const res = await fetch(`${C.FUNCTIONS_URL}/notify-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.session.access_token}`, apikey: C.SUPABASE_ANON_KEY },
          body: JSON.stringify({ channel_id: Number(b.dataset.test) }),
        });
        const r = await res.json();
        r.ok ? msg('ส่งสำเร็จ — ตรวจดูข้อความในกลุ่ม LINE')
             : msg(`ส่งไม่สำเร็จ (HTTP ${r.status ?? res.status}) ${r.response ?? r.error ?? ''}`, true);
      } catch (e) { fail(e); }
      b.disabled = false;
    }));
  }

  // ---------- 7) ตั้งค่าการแจ้งเตือนผู้บริจาคทาง LINE (เฉพาะ admin) ----------
  // ข้อความ push ทุกข้อความหักโควตา LINE OA จึงเปิด/ปิดแยกได้ (การแจ้งเจ้าหน้าที่ผ่านหมอพร้อมไม่เกี่ยวกับโควตานี้)
  const DONOR_NOTIFY = [
    ['notify_booking_confirm', true,  'ข้อความยืนยันเมื่อจองสำเร็จ', 'ส่ง 1 ข้อความต่อการจอง · แนะนำให้เปิด'],
    ['notify_cancel_confirm',  false, 'ข้อความยืนยันเมื่อผู้บริจาคยกเลิกคิวเอง', 'ผู้บริจาคเห็นผลบนหน้าจอ LIFF อยู่แล้ว จึงมักไม่จำเป็น'],
    ['notify_reminder',        false, 'เตือนล่วงหน้า 1 วันก่อนนัด', 'ช่วยลดคนไม่มาตามนัด แต่ใช้ 1 ข้อความต่อคิว'],
    ['notify_status_change',   false, 'แจ้งเมื่อเจ้าหน้าที่เปลี่ยนสถานะ (สำเร็จ / ยกเลิก / ไม่มา)', 'ผู้บริจาคดูสถานะได้เองในหน้า LIFF > ประวัติ'],
  ];
  async function settings() {
    const { data, error } = await sb.from('app_settings').select('key, value');
    if (error) return fail({ message: 'อ่านการตั้งค่าไม่ได้ — ยังไม่ได้รันไฟล์ settings.sql ใน Supabase หรือไม่? (' + error.message + ')' });
    const cur = Object.fromEntries(data.map((r) => [r.key, r.value === 'true']));
    $('view').innerHTML = `<div class="card"><h2>ตั้งค่าการแจ้งเตือนผู้บริจาคทาง LINE</h2>
      <p class="mute">ทุกข้อความที่ระบบ "ส่ง" (push) หาผู้บริจาคจะหักโควตาข้อความของ LINE OA ตามแพ็กเกจของคุณ — เปิดเฉพาะที่จำเป็น
      (ตรวจโควตาที่เหลือได้ใน LINE OA Manager) · การแจ้งเจ้าหน้าที่ผ่านหมอพร้อมไม่ใช้โควตานี้และไม่ได้รับผลจากหน้านี้</p>
      ${DONOR_NOTIFY.map(([k, def, label, hint]) => `<label class="sw"><input type="checkbox" data-key="${k}" ${(k in cur ? cur[k] : def) ? 'checked' : ''}>
        <span><b>${esc(label)}</b><br><small class="mute">${esc(hint)}</small></span></label>`).join('')}
      <div class="row" style="margin-top:12px"><button class="btn" id="savesettings">บันทึกการตั้งค่า</button></div></div>`;
    $('savesettings').onclick = async () => {
      const rows = [...document.querySelectorAll('[data-key]')].map((c) => ({ key: c.dataset.key, value: c.checked ? 'true' : 'false' }));
      const { error: e } = await sb.from('app_settings').upsert(rows, { onConflict: 'key' });
      e ? fail(e) : msg('บันทึกแล้ว (มีผลทันที)');
    };
  }

  boot();
})();
