// แดชบอร์ดเจ้าหน้าที่: ล็อกอินด้วย Supabase Auth, สิทธิ์ควบคุมด้วย RLS ฝั่งฐานข้อมูล
// (หน้านี้ใช้ anon key เท่านั้น - ถ้าไม่ใช่ผู้ใช้ใน admin_users จะอ่าน/เขียนข้อมูลไม่ได้)
(() => {
  'use strict';
  const C = window.CONFIG;
  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const root = document.getElementById('root');

  const S = { me: null, tab: 'bookings', view: 'week', date: bkkToday(), year: new Date().getFullYear() };
  const TABS = [['bookings', 'รายการจอง'], ['holidays', 'วันหยุด'], ['slots', 'ช่วงเวลา/ขีดจำกัดคิว'],
                ['stats', 'สถิติ'], ['export', 'ดาวน์โหลดข้อมูล'], ['search', 'ค้นหาผู้บริจาค'], ['channels', 'ห้องแจ้งเตือน (หมอพร้อม)'], ['settings', 'แจ้งเตือนผู้บริจาค (LINE)']];
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
    ({ bookings, holidays, slots, stats, export: exportTab, search, channels, settings })[S.tab]();
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

  const dowOf = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();            // 0=อาทิตย์ ... 6=เสาร์
  // ขีดจำกัดของ "วันนั้น": จ-ศ = max_capacity, เสาร์ = sat_capacity, อาทิตย์ = sun_capacity (0 = ปิดรับ)
  const capOf = (s, iso) => { const w = dowOf(iso); return Number(w === 6 ? s.sat_capacity : w === 0 ? s.sun_capacity : s.max_capacity) || 0; };

  async function weekView() {
    const mon = mondayOf(S.date), sun = addDays(mon, 6);
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

    const [slotsR, bkR, holR] = await Promise.all([
      sb.from('time_slots').select('*').order('start_time'),
      sb.from('bookings').select('id, user_id, booking_date, time_slot_id, status').gte('booking_date', mon).lte('booking_date', sun),
      sb.from('hospital_holidays').select('holiday_date, name').gte('holiday_date', mon).lte('holiday_date', sun),
    ]);
    for (const r of [slotsR, bkR, holR]) if (r.error) throw r.error;
    // แสดงเสาร์-อาทิตย์เมื่อมีช่วงใดเปิดรับในวันนั้น หรือมีคิวจองค้างอยู่ (กันคิวหายจากหน้าจอ)
    const weekendOn = slotsR.data.some((s) => s.sat_capacity > 0 || s.sun_capacity > 0) ||
      bkR.data.some((b) => [0, 6].includes(dowOf(b.booking_date)));
    const days = Array.from({ length: weekendOn ? 7 : 5 }, (_, n) => addDays(mon, n));
    const last = days[days.length - 1];
    $('wtitle').textContent = `${fmt(mon, { day: 'numeric', month: 'short' })} - ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    const users = await loadUsers(bkR.data);
    const hol = Object.fromEntries(holR.data.map((h) => [h.holiday_date, h.name]));
    const today = bkkToday();
    const nameOf = (b) => users.get(b.user_id)?.full_name || users.get(b.user_id)?.display_name || '(ไม่ระบุ)';
    const nmList = (list) => list.map((b) => `<div class="nm ${b.status}" title="${esc(STATUS[b.status][0])}">${esc(nameOf(b))}${b.status === 'completed' ? ' ✓' : b.status === 'no_show' ? ' ✗' : ''}</div>`).join('');

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
            ? `<td class="hol"><div class="cnt">⚠ ${used} คิวค้าง</div>${nmList(list)}</td>`
            : '<td class="hol">หยุด</td>';
          continue;
        }
        const cap = s.is_active ? capOf(s, d) : 0;
        if (cap <= 0) {
          // ปิดรับ (ตั้งเป็น 0 หรือปิดช่วงเวลา) แต่ถ้ายังมีคิวเดิมค้างอยู่ให้แสดงเตือน
          dayTotals[d].used += used;
          html += list.length
            ? `<td class="hol"><div class="cnt">⚠ ${used} คิว (ปิดรับแล้ว)</div>${nmList(list)}</td>`
            : '<td class="off">-</td>';
          continue;
        }
        dayTotals[d].used += used; dayTotals[d].cap += cap;
        const cls = used >= cap ? 'full' : used > 0 ? 'some' : 'empty';
        html += `<td class="${cls} ${d === today ? 'today' : ''}"><div class="cnt">${used}/${cap}</div>${nmList(list)}</td>`;
      }
      html += '</tr>';
    }
    html += '<tr class="tot"><th class="slt">รวมต่อวัน</th>' +
      days.map((d) => (hol[d] ? `<td class="hol">${dayTotals[d].used ? '⚠ ' + dayTotals[d].used + ' คิวค้าง' : '-'}</td>` : dayTotals[d].cap ? `<td><b>${dayTotals[d].used}</b> / ${dayTotals[d].cap}</td>` : `<td>${dayTotals[d].used ? '⚠ ' + dayTotals[d].used : '-'}</td>`)).join('') + '</tr></table></div>';

    const usedAll = Object.values(dayTotals).reduce((a, t) => a + t.used, 0), capAll = Object.values(dayTotals).reduce((a, t) => a + t.cap, 0);
    $('wk').className = '';
    $('wk').innerHTML = `<p style="margin:4px 0 10px"><b>สัปดาห์นี้จอง ${usedAll} คิว</b> จากที่รับได้ ${capAll} คิว (ว่าง ${Math.max(capAll - usedAll, 0)})</p>${html}
      <p class="mute" style="margin-top:8px"><span class="lg full"></span>เต็ม <span class="lg some"></span>มีผู้จอง <span class="lg empty"></span>ว่าง <span class="lg hol"></span>วันหยุด/ปิดรับ
      · ✓ = บริจาคสำเร็จ · ✗ = ไม่มา · คิวที่ยกเลิกไม่แสดง · กดที่หัววันเพื่อเปลี่ยนสถานะรายวัน${weekendOn ? '' : ' · เสาร์-อาทิตย์ปิดรับ (เปิดได้ที่แท็บ "ช่วงเวลา/ขีดจำกัดคิว")'}</p>`;
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
      <p class="mute">วันที่เพิ่มที่นี่จะปิดรับจองทันที แม้เป็นเสาร์-อาทิตย์ที่เปิดรับตามปกติ (ไม่ยกเลิกคิวที่จองไว้แล้ว) · เสาร์-อาทิตย์เปิด/ปิดที่แท็บ "ช่วงเวลา/ขีดจำกัดคิว"</p>
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
    if (data.length && !('sat_capacity' in data[0])) {
      return fail({ message: 'ฐานข้อมูลยังไม่รองรับเสาร์-อาทิตย์ — รันไฟล์ weekend.sql ใน Supabase SQL Editor ก่อน (ดูคู่มือ "อัปเดต v4")' });
    }
    const num = (id, v) => `<input type="number" min="0" max="50" id="${id}" value="${v}">`;
    $('view').innerHTML = `<div class="card"><h2>ขีดจำกัดคิวต่อช่วงเวลา</h2>
      <p class="mute">กำหนดจำนวนที่รับได้ <b>แยกตามประเภทวัน</b> · ใส่ <b>0 = ปิดรับ</b>วันประเภทนั้น (เช่น เสาร์เปิดเฉพาะช่วงเช้า ก็ใส่ 0 ที่ช่วงบ่าย) ·
      วันหยุดที่เพิ่มในแท็บ "วันหยุด" ปิดรับเสมอ · มีผลกับการจองใหม่ (คิวเดิมไม่ถูกยกเลิก)</p>
      <table><tr><th>ช่วงเวลา</th><th>จันทร์-ศุกร์</th><th>เสาร์</th><th>อาทิตย์</th><th>เปิดใช้งาน</th><th></th></tr>
      ${data.map((s) => `<tr><td>${esc(s.label)} น.</td><td>${num('c' + s.id, s.max_capacity)}</td><td>${num('sa' + s.id, s.sat_capacity)}</td><td>${num('su' + s.id, s.sun_capacity)}</td>
        <td><input type="checkbox" id="a${s.id}" ${s.is_active ? 'checked' : ''}></td>
        <td><button class="btn sm" data-id="${s.id}">บันทึก</button></td></tr>`).join('')}</table></div>`;
    document.querySelectorAll('#view button[data-id]').forEach((b) => (b.onclick = async () => {
      const id = b.dataset.id;
      const v = { max_capacity: Number($('c' + id).value), sat_capacity: Number($('sa' + id).value), sun_capacity: Number($('su' + id).value) };
      if (!Object.values(v).every((n) => Number.isInteger(n) && n >= 0 && n <= 50)) return msg('จำนวนต้องเป็นเลข 0-50', true);
      const { error } = await sb.from('time_slots').update({ ...v, is_active: $('a' + id).checked }).eq('id', id);
      error ? fail(error) : msg('บันทึกแล้ว');
    }));
  }

  // ---------- ตัวช่วยเลือกช่วงวันที่ (ใช้ร่วมกันระหว่างแท็บสถิติและดาวน์โหลด) ----------
  const monthStart = (iso, add = 0) => { const [y, m] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + add, 1)).toISOString().slice(0, 10); };
  const PRESETS = [
    ['thismonth', 'เดือนนี้'], ['lastmonth', 'เดือนที่แล้ว'], ['last30', '30 วันล่าสุด'],
    ['fy', 'ปีงบประมาณนี้'], ['thisyear', 'ปีนี้ (ม.ค.-ธ.ค.)'], ['all', 'ทั้งหมด'],
  ];
  function presetRange(k) {
    const t = bkkToday(), y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
    if (k === 'thismonth') return [monthStart(t), addDays(monthStart(t, 1), -1)];
    if (k === 'lastmonth') return [monthStart(t, -1), addDays(monthStart(t), -1)];
    if (k === 'last30') return [addDays(t, -29), t];
    if (k === 'fy') { const fy = m >= 10 ? y : y - 1; return [`${fy}-10-01`, `${fy + 1}-09-30`]; }   // ปีงบประมาณไทย 1 ต.ค. - 30 ก.ย.
    if (k === 'thisyear') return [`${y}-01-01`, `${y}-12-31`];
    return ['2020-01-01', addDays(t, 90)];
  }
  const rangeBar = (from, to) => `<div class="row"><label>ตั้งแต่ <input type="date" id="rf" value="${from}"></label>
      <label>ถึง <input type="date" id="rt" value="${to}"></label></div>
    <div class="row">${PRESETS.map(([k, t]) => `<button class="btn sec sm" data-preset="${k}">${t}</button>`).join('')}</div>`;
  function wireRange(onPreset) {
    document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
      const [f, t] = presetRange(b.dataset.preset); $('rf').value = f; $('rt').value = t; onPreset();
    }));
  }
  function readRange() {
    const f = $('rf').value, t = $('rt').value;
    if (!f || !t) { msg('เลือกวันที่เริ่มและวันที่สิ้นสุดให้ครบ', true); return null; }
    if (f > t) { msg('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด', true); return null; }
    if (new Date(t) - new Date(f) > 20 * 366 * 864e5) { msg('เลือกช่วงได้ไม่เกิน 20 ปี', true); return null; }
    msg(''); return [f, t];
  }

  // ---------- CSV ----------
  // - ใส่ BOM เพื่อให้ Excel อ่านภาษาไทยถูก · ขึ้นบรรทัดใหม่แบบ CRLF
  // - กันสูตรแฝง (CSV injection): ข้อความที่ขึ้นต้นด้วย = + - @ จะถูกนำหน้าด้วย '
  // - excelPhone: เบอร์โทรเป็น ="0812345678" เพื่อไม่ให้ Excel ตัดเลข 0 หน้า (ปิดตัวเลือกนี้ถ้าจะนำเข้าโปรแกรมอื่น)
  function csvCell(v, { phone = false, excel = false } = {}) {
    if (v === null || v === undefined) return '';
    let t = String(v);
    if (phone && excel && /^[0-9+\- ]+$/.test(t)) return `"=""${t}"""`;
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }
  function downloadCsv(name, header, rows) {
    const text = '﻿' + [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- 4) สถิติ (เลือกช่วงวันที่) ----------
  const GROUPS = [['auto', 'อัตโนมัติ'], ['day', 'รายวัน'], ['week', 'รายสัปดาห์'], ['month', 'รายเดือน'], ['year', 'รายปี']];
  const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '-');
  function periodLabel(p, g) {
    if (g === 'day') return fmt(p, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (g === 'week') return `${fmt(p, { day: 'numeric', month: 'short' })} - ${fmt(addDays(p, 6), { day: 'numeric', month: 'short', year: '2-digit' })}`;
    if (g === 'year') return fmt(p, { year: 'numeric' });
    return fmt(p, { month: 'long', year: 'numeric' });
  }

  async function stats() {
    if (!S.sFrom) [S.sFrom, S.sTo] = presetRange('fy');
    S.sGroup = S.sGroup || 'auto';
    $('view').innerHTML = `<div class="card"><h2>สถิติการจองและการบริจาค</h2>
      ${rangeBar(S.sFrom, S.sTo)}
      <div class="row"><label>แสดงแบบ <select id="grp">${GROUPS.map(([k, t]) => `<option value="${k}" ${S.sGroup === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <button class="btn sm" id="showstats">ดูสถิติ</button></div>
      <div id="statsbox" class="mute">กำลังโหลด...</div></div>`;
    const run = () => { const r = readRange(); if (!r) return; [S.sFrom, S.sTo] = r; S.sGroup = $('grp').value; stats(); };
    $('showstats').onclick = run; wireRange(run);

    const days = Math.round((new Date(S.sTo) - new Date(S.sFrom)) / 864e5) + 1;
    let g = S.sGroup;
    if (g === 'auto') g = days <= 31 ? 'day' : days <= 120 ? 'week' : days <= 1100 ? 'month' : 'year';
    let note = '';
    if (g === 'day' && days > 366) { g = 'week'; note = 'ช่วงยาวเกิน 1 ปี จึงแสดงเป็นรายสัปดาห์แทน'; }
    const { data, error } = await sb.rpc('stats_range', { p_from: S.sFrom, p_to: S.sTo, p_group: g });
    if (error) return fail(error.code === 'PGRST202' || /stats_range/.test(error.message || '') ? { message: 'ยังไม่ได้รันไฟล์ reports.sql ใน Supabase (ดูคู่มือ "อัปเดต v4") — ' + error.message } : error);
    const box = $('statsbox'); box.className = '';
    if (!data.length) { box.innerHTML = '<p class="mute">ไม่มีข้อมูลในช่วงที่เลือก</p>'; return; }
    const max = Math.max(...data.map((r) => r.booked), 1);
    const t = data.reduce((a, r) => ({ b: a.b + r.booked, p: a.p + r.pending, c: a.c + r.completed, x: a.x + r.cancelled, n: a.n + r.no_show, nd: a.nd + r.new_donors }),
      { b: 0, p: 0, c: 0, x: 0, n: 0, nd: 0 });
    const tile = (label, v, cls) => `<div class="kpi ${cls}"><div class="kv">${v}</div><div class="kl">${label}</div></div>`;
    const rangeTxt = `${fmt(S.sFrom, { day: 'numeric', month: 'short', year: 'numeric' })} - ${fmt(S.sTo, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    box.innerHTML = `
      <p class="mute" style="margin:0 0 6px">ช่วง ${esc(rangeTxt)} (นับตามวันที่นัด) ${note ? '· ' + esc(note) : ''}</p>
      <div class="kpis">${tile('จองทั้งหมด', t.b, '')}${tile('รอยืนยัน (ยังไม่บันทึกผล)', t.p, 'warn')}${tile('บริจาคสำเร็จ', t.c, 'ok')}${tile('ผู้บริจาคครั้งแรก', t.nd, 'ok')}
        ${tile('ยกเลิก', t.x, 'bad')}${tile('ไม่มา', t.n, 'bad')}${tile('อัตราสำเร็จ (สำเร็จ ÷ มา+ไม่มา)', pct(t.c, t.c + t.n), 'ok')}${tile('อัตราไม่มาตามนัด', pct(t.n, t.c + t.n), 'warn')}</div>
      <h3>${esc(GROUPS.find(([k]) => k === g)[1])}</h3>
      <div class="tblwrap"><table><tr><th>ช่วง</th><th>จอง</th><th>รอ</th><th>สำเร็จ</th><th>ครั้งแรก</th><th>ยกเลิก</th><th>ไม่มา</th><th style="min-width:140px">กราฟ</th></tr>
      ${data.map((r) => `<tr><td>${esc(periodLabel(r.period, g))}</td><td>${r.booked}</td><td>${r.pending}</td><td>${r.completed}</td><td>${r.new_donors}</td><td>${r.cancelled}</td><td>${r.no_show}</td>
        <td><div class="bar" style="width:${(r.booked / max) * 100}%"></div><div class="bar g" style="width:${(r.completed / max) * 100}%;margin-top:2px"></div></td></tr>`).join('')}</table></div>
      <p class="mute" style="margin-top:8px">แถบแดง = จอง · แถบเขียว = บริจาคสำเร็จ</p>
      <div class="row" style="margin-top:10px"><button class="btn sec sm" id="dlstats">⬇ ดาวน์โหลดตารางสถิตินี้ (CSV · ไม่มีข้อมูลส่วนบุคคล)</button>
        <button class="btn sec sm" id="togo">⬇ ไปดาวน์โหลดรายชื่อผู้จองช่วงนี้</button></div>`;
    $('dlstats').onclick = () => downloadCsv(`stats_${S.sFrom}_to_${S.sTo}.csv`,
      ['ช่วง(วันแรก)', 'จอง', 'รอยืนยัน', 'บริจาคสำเร็จ', 'ผู้บริจาคครั้งแรก', 'ยกเลิก', 'ไม่มา'],
      data.map((r) => [r.period, r.booked, r.pending, r.completed, r.new_donors, r.cancelled, r.no_show]));
    $('togo').onclick = () => { S.eFrom = S.sFrom; S.eTo = S.sTo; S.tab = 'export'; shell(); };
  }

  // ---------- 4.5) ดาวน์โหลดข้อมูล (รายชื่อผู้จอง) ----------
  const EXP_STATUS = [['', 'ทุกสถานะ'], ['completed', 'เฉพาะ: มาบริจาคสำเร็จ'], ['pending', 'เฉพาะ: รอยืนยัน'], ['cancelled', 'เฉพาะ: ยกเลิก'], ['no_show', 'เฉพาะ: ไม่มา']];
  const bkkTime = (iso) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');

  async function exportTab() {
    if (!S.eFrom) [S.eFrom, S.eTo] = presetRange('thismonth');
    const isAdmin = S.me.role === 'admin';
    $('view').innerHTML = `<div class="card"><h2>ดาวน์โหลดรายชื่อผู้จอง</h2>
      <div class="disclaimer">⚠ ไฟล์นี้มี <b>ข้อมูลส่วนบุคคล</b> (ชื่อ เบอร์โทร) — ใช้เฉพาะงานของธนาคารเลือด เก็บในที่ปลอดภัย และลบเมื่อใช้เสร็จ · ระบบบันทึกชื่อผู้ดาวน์โหลดทุกครั้ง</div>
      <h3>1) เลือกช่วงวันที่นัด</h3>${rangeBar(S.eFrom, S.eTo)}
      <h3>2) ตัวเลือก</h3>
      <div class="row"><label>สถานะ <select id="est">${EXP_STATUS.map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label></div>
      <label class="ck"><input type="checkbox" id="eanon"> ไม่รวมชื่อ-นามสกุล/เบอร์โทร/ชื่อ LINE (สำหรับวิเคราะห์สถิติอย่างเดียว)</label><br>
      <label class="ck"><input type="checkbox" id="exl" checked> จัดรูปแบบสำหรับเปิดด้วย Excel (เบอร์โทรไม่ถูกตัดเลข 0 หน้า) — ปิดข้อนี้ถ้าจะนำเข้าโปรแกรมอื่น</label>
      <h3>3) ดูตัวอย่าง แล้วดาวน์โหลด</h3>
      <div class="row"><button class="btn sec" id="prev">ดูตัวอย่าง 20 แถวแรก</button><button class="btn" id="dl">⬇ ดาวน์โหลด CSV</button></div>
      <div id="prevbox" class="mute"></div></div>
      ${isAdmin ? `<div class="card"><h2>ทะเบียนผู้บริจาค (เฉพาะผู้ดูแล)</h2>
        <p class="mute">ไฟล์รูปแบบกลางสำหรับนำเข้าโปรแกรมบันทึกผู้บริจาค/ระบบอื่น — <b>มีเลขบัตรประชาชน</b> (หัวคอลัมน์เป็นภาษาอังกฤษ วันที่เป็น ค.ศ. ปปปป-ดด-วว) ·
        ผู้ที่มีหลายบัญชี LINE แต่เลขบัตรเดียวกันรวมเป็นแถวเดียว · การเลือกช่วงวันที่ด้านบนใช้กับ "รายการบริจาค"</p>
        <div class="row"><button class="btn sec" id="dldonors">⬇ ทะเบียนผู้บริจาคทั้งหมด (donors.csv)</button>
        <button class="btn sec" id="dldonations">⬇ รายการบริจาครายครั้ง (donations.csv)</button></div></div>` : ''}
      ${isAdmin ? '<div class="card"><h2>ประวัติการดาวน์โหลด (เฉพาะผู้ดูแล)</h2><div id="hist" class="mute">กำลังโหลด...</div></div>' : ''}`;
    wireRange(() => { $('prevbox').innerHTML = ''; });

    const HEAD = ['วันที่นัด', 'ช่วงเวลา', 'สถานะ', 'รหัสสถานะ', 'ชื่อ-นามสกุล', 'เบอร์โทร', 'ชื่อใน LINE', 'เวลาที่จอง', 'เวลายกเลิก',
      'เลขใบเกียรติบัตร', 'วันที่บริจาค', 'จำนวนครั้งที่บริจาคสะสม', 'บริจาคครั้งแรก', 'รหัสการจอง'];
    const PERSONAL = [4, 5, 6];                                       // คอลัมน์ข้อมูลส่วนบุคคล
    const fetchPage = (r, st, off, lim) => sb.rpc('export_bookings', { p_from: r[0], p_to: r[1], p_status: st || null, p_limit: lim, p_offset: off });
    const toRow = (x, anon, excel) => {
      const c = (v, o) => csvCell(v, o);
      const all = [c(x.booking_date), c(x.slot_label), c(STATUS[x.status]?.[0] ?? x.status), c(x.status),
        c(x.full_name ?? ''), c(x.phone ?? '', { phone: true, excel }), c(x.line_display_name ?? ''),
        c(bkkTime(x.booked_at)), c(bkkTime(x.cancelled_at)), c(x.certificate_no ?? ''), c(x.donated_on ?? ''),
        c(x.donation_count), c(x.status === 'completed' ? (x.is_first_time ? 'ใช่' : 'ไม่ใช่') : ''), c(x.booking_id)];
      return anon ? all.filter((_, i) => !PERSONAL.includes(i)) : all;
    };
    const head = (anon) => (anon ? HEAD.filter((_, i) => !PERSONAL.includes(i)) : HEAD).map((h) => csvCell(h));
    const noFn = (e) => fail(/export_bookings|export_log/.test(e.message || '') && /not find|does not exist|schema cache/.test(e.message || '')
      ? { message: 'ยังไม่ได้รันไฟล์ reports.sql ใน Supabase (ดูคู่มือ "อัปเดต v4") — ' + e.message } : e);

    $('prev').onclick = async () => {
      const r = readRange(); if (!r) return;
      $('prevbox').textContent = 'กำลังโหลด...';
      const { data, error } = await fetchPage(r, $('est').value, 0, 20);
      if (error) { $('prevbox').textContent = ''; return noFn(error); }
      if (!data.length) { $('prevbox').textContent = 'ไม่มีข้อมูลในช่วง/สถานะที่เลือก'; return; }
      const anon = $('eanon').checked;
      $('prevbox').className = 'tblwrap';
      $('prevbox').innerHTML = `<table><tr><th>วันที่นัด</th><th>ช่วงเวลา</th><th>สถานะ</th>${anon ? '' : '<th>ชื่อ-นามสกุล</th><th>เบอร์โทร</th>'}<th>ครั้งที่</th></tr>
        ${data.map((x) => `<tr><td>${esc(x.booking_date)}</td><td>${esc(x.slot_label)}</td><td>${esc(STATUS[x.status]?.[0] ?? x.status)}</td>${anon ? '' : `<td>${esc(x.full_name || '(ลบข้อมูลแล้ว)')}</td><td>${esc(x.phone || '-')}</td>`}<td>${x.donation_count}</td></tr>`).join('')}</table>
        <p class="mute">ตัวอย่างเท่านั้น — ไฟล์จริงมีครบทุกแถวและทุกคอลัมน์</p>`;
    };

    $('dl').onclick = async () => {
      const r = readRange(); if (!r) return;
      const st = $('est').value, anon = $('eanon').checked, excel = $('exl').checked;
      const btn = $('dl'); btn.disabled = true; msg('กำลังดึงข้อมูล...');
      try {
        const rows = [];
        for (let off = 0; off < 50000; off += 1000) {                 // ดึงทีละ 1,000 แถว สูงสุด 50,000
          const { data, error } = await fetchPage(r, st, off, 1000);
          if (error) throw error;
          rows.push(...data);
          if (data.length < 1000) break;
        }
        if (!rows.length) { msg('ไม่มีข้อมูลในช่วง/สถานะที่เลือก — ไม่มีไฟล์ให้ดาวน์โหลด', true); return; }
        // บันทึกประวัติก่อนส่งไฟล์ — ถ้าบันทึกไม่ได้ จะไม่ให้ดาวน์โหลด (ตรวจสอบย้อนหลังได้เสมอ)
        const { error: le } = await sb.from('export_log').insert({ staff_name: S.me.display_name, date_from: r[0], date_to: r[1], status_filter: st || null, row_count: rows.length });
        if (le) throw le;
        downloadCsv(`bookings_${r[0]}_to_${r[1]}${st ? '_' + st : ''}${anon ? '_anon' : ''}.csv`, head(anon), rows.map((x) => toRow(x, anon, excel)));
        msg(`ดาวน์โหลดแล้ว ${rows.length} แถว — กรุณาเก็บไฟล์อย่างปลอดภัยและลบเมื่อใช้เสร็จ`);
        if (isAdmin) loadHist();
      } catch (e) { noFn(e); }
      btn.disabled = false;
    };

    async function loadHist() {
      const { data, error } = await sb.from('export_log').select('created_at, staff_name, date_from, date_to, status_filter, row_count, kind').order('created_at', { ascending: false }).limit(20);
      const h = $('hist'); if (!h) return;
      if (error) { h.textContent = 'อ่านประวัติไม่ได้: ' + error.message; return; }
      h.className = '';
      h.innerHTML = data.length ? `<table><tr><th>เมื่อ</th><th>ผู้ดาวน์โหลด</th><th>ชนิด</th><th>ช่วงวันที่</th><th>สถานะ</th><th>แถว</th></tr>
        ${data.map((x) => `<tr><td>${esc(bkkTime(x.created_at))}</td><td>${esc(x.staff_name || '-')}</td><td>${esc({ donors: 'ทะเบียนผู้บริจาค', donations: 'รายการบริจาค' }[x.kind] || 'รายชื่อผู้จอง')}</td><td>${esc(x.date_from)} ถึง ${esc(x.date_to)}</td><td>${esc(STATUS[x.status_filter]?.[0] || 'ทุกสถานะ')}</td><td>${x.row_count}</td></tr>`).join('')}</table>`
        : 'ยังไม่มีการดาวน์โหลด';
    }
    if (isAdmin) {
      const pageAll = async (fn, args) => {
        const rows = [];
        for (let off = 0; off < 100000; off += 1000) {
          const { data, error } = await sb.rpc(fn, { ...args, p_limit: 1000, p_offset: off });
          if (error) throw error;
          rows.push(...data); if (data.length < 1000) break;
        }
        return rows;
      };
      const runAdminExport = async (btn, kind, fn, args, name, head, toRow, range) => {
        btn.disabled = true; msg('กำลังดึงข้อมูล...');
        try {
          const rows = await pageAll(fn, args);
          if (!rows.length) { msg('ไม่มีข้อมูลให้ดาวน์โหลด', true); return; }
          const t = bkkToday();
          const { error: le } = await sb.from('export_log').insert({ staff_name: S.me.display_name, date_from: range?.[0] ?? t, date_to: range?.[1] ?? t, row_count: rows.length, kind });
          if (le) throw le;
          const excel = $('exl').checked;
          downloadCsv(name, head.map((h) => csvCell(h)), rows.map((x) => toRow(x, excel)));
          msg(`ดาวน์โหลดแล้ว ${rows.length} แถว — ไฟล์มีเลขบัตรประชาชน กรุณาเก็บอย่างปลอดภัยและลบเมื่อใช้เสร็จ`);
          loadHist();
        } catch (e) { noFn(e); }
        btn.disabled = false;
      };
      const c = (v, o) => csvCell(v, o);
      $('dldonors').onclick = (ev) => runAdminExport(ev.currentTarget, 'donors', 'export_donors', {}, `donors_${bkkToday()}.csv`,
        ['cid', 'first_name', 'last_name', 'gender', 'birth_date', 'age', 'phone', 'first_donation_date', 'last_donation_date', 'donation_count', 'donor_ref'],
        (x, ex) => [c(x.cid, { phone: true, excel: ex }), c(x.first_name), c(x.last_name), c(x.gender), c(x.birth_date), c(x.age), c(x.phone, { phone: true, excel: ex }),
          c(x.first_donation), c(x.last_donation), c(x.donation_count), c(x.donor_ref)]);
      $('dldonations').onclick = (ev) => {
        const r = readRange(); if (!r) return;
        runAdminExport(ev.currentTarget, 'donations', 'export_donations', { p_from: r[0], p_to: r[1] }, `donations_${r[0]}_to_${r[1]}.csv`,
          ['cid', 'donated_on', 'certificate_no', 'booking_id', 'donor_ref'],
          (x, ex) => [c(x.cid, { phone: true, excel: ex }), c(x.donated_on), c(x.certificate_no), c(x.booking_id), c(x.donor_ref)], r);
      };
    }
    if (isAdmin) loadHist();
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
  const CHANNELS = [
    ['line', 'LINE OA (ใช้โควตาข้อความ push ของ LINE OA)'],
    ['moph_alert', 'MOPH Alert (หมอพร้อม) อย่างเดียว — ไม่ใช้โควตา LINE OA'],
    ['moph_alert_then_line', 'MOPH Alert ก่อน ถ้าส่งไม่สำเร็จค่อยส่งทาง LINE'],
  ];
  async function settings() {
    const { data, error } = await sb.from('app_settings').select('key, value');
    if (error) return fail({ message: 'อ่านการตั้งค่าไม่ได้ — ยังไม่ได้รันไฟล์ settings.sql ใน Supabase หรือไม่? (' + error.message + ')' });
    const raw = Object.fromEntries(data.map((r) => [r.key, r.value]));
    const cur = Object.fromEntries(data.map((r) => [r.key, r.value === 'true']));
    $('view').innerHTML = `<div class="card"><h2>ช่องทางแจ้งผู้บริจาค</h2>
      <p class="mute">เลือกว่าข้อความถึงผู้บริจาคจะส่งทางใด · MOPH Alert ส่งโดยใช้เลขบัตรประชาชนที่ผู้บริจาคกรอก (ต้องตั้งค่า Secrets ของ MOPH Alert ในฟังก์ชันก่อน — ดูคู่มือ "อัปเดต v5")
      ผู้ที่ไม่มีเลขบัตรในระบบจะส่งทาง LINE เมื่อเลือก "ก่อน ... แล้วค่อย LINE"</p>
      <select id="donorch">${CHANNELS.map(([k, t]) => `<option value="${k}" ${(raw.donor_channel || 'line') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <div class="row" style="margin-top:10px"><label>ทดสอบ MOPH Alert: ส่งหาเลขบัตรของคุณเอง <input id="alertcid" type="text" inputmode="numeric" maxlength="17" placeholder="13 หลัก"></label>
        <button class="btn sec sm" id="alerttest">ส่งทดสอบ</button></div></div>
      <div class="card"><h2>ตั้งค่าการแจ้งเตือนผู้บริจาค</h2>
      <p class="mute">ทุกข้อความที่ส่งหาผู้บริจาคทาง LINE จะหักโควตาข้อความของ LINE OA ตามแพ็กเกจของคุณ — เปิดเฉพาะที่จำเป็น
      (ตรวจโควตาที่เหลือได้ใน LINE OA Manager) · การแจ้งเจ้าหน้าที่ผ่านหมอพร้อมไม่ใช้โควตานี้และไม่ได้รับผลจากหน้านี้</p>
      ${DONOR_NOTIFY.map(([k, def, label, hint]) => `<label class="sw"><input type="checkbox" data-key="${k}" ${(k in cur ? cur[k] : def) ? 'checked' : ''}>
        <span><b>${esc(label)}</b><br><small class="mute">${esc(hint)}</small></span></label>`).join('')}
      <div class="row" style="margin-top:12px"><button class="btn" id="savesettings">บันทึกการตั้งค่า</button></div></div>`;
    $('savesettings').onclick = async () => {
      const rows = [...document.querySelectorAll('[data-key]')].map((c) => ({ key: c.dataset.key, value: c.checked ? 'true' : 'false' }));
      rows.push({ key: 'donor_channel', value: $('donorch').value });
      const { error: e } = await sb.from('app_settings').upsert(rows, { onConflict: 'key' });
      e ? fail(e) : msg('บันทึกแล้ว (มีผลทันที)');
    };
    $('alerttest').onclick = async () => {
      const cid = $('alertcid').value.replace(/\D/g, '');
      if (cid.length !== 13) return msg('กรอกเลขบัตรประชาชน 13 หลักของคุณเอง', true);
      msg('กำลังส่งข้อความทดสอบ...');
      try {
        const { data: ss } = await sb.auth.getSession();
        const res = await fetch(`${C.FUNCTIONS_URL}/notify-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ss.session.access_token}`, apikey: C.SUPABASE_ANON_KEY },
          body: JSON.stringify({ alert_cid: cid }),
        });
        const r = await res.json();
        $('alertcid').value = '';
        r.ok ? msg('ส่งสำเร็จ — ตรวจดูข้อความในแอป/LINE หมอพร้อม')
             : msg(r.response === 'NOT_CONFIGURED' ? 'ยังไม่ได้ตั้ง Secrets ของ MOPH Alert ในฟังก์ชัน' : `ส่งไม่สำเร็จ (HTTP ${r.status ?? res.status}) ${r.response ?? r.error ?? ''}`, true);
      } catch (e) { fail(e); }
    };
  }

  boot();
})();
