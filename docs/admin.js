// แดชบอร์ดเจ้าหน้าที่: ล็อกอินด้วย Supabase Auth, สิทธิ์ควบคุมด้วย RLS ฝั่งฐานข้อมูล
// (หน้านี้ใช้ anon key เท่านั้น - ถ้าไม่ใช่ผู้ใช้ใน admin_users จะอ่าน/เขียนข้อมูลไม่ได้)
(() => {
  'use strict';
  const C = window.CONFIG;
  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const root = document.getElementById('root');

  const S = { me: null, tab: 'bookings', view: 'week', date: bkkToday(), year: new Date().getFullYear() };
  const TABS = [['bookings', 'รายการจอง'], ['holidays', 'วันหยุด'], ['slots', 'ช่วงเวลา/ขีดจำกัดคิว'],
                ['usage', 'การใช้เลือด'], ['stats', 'สถิติ'], ['export', 'ดาวน์โหลดข้อมูล'], ['search', 'ค้นหาผู้บริจาค'], ['channels', 'ห้องแจ้งเตือน (หมอพร้อม)'], ['settings', 'แจ้งเตือนผู้บริจาค (LINE)']];
  const STATUS = { pending: ['รอยืนยัน', 'warn'], confirmed: ['ยืนยัน', 'info'], calling: ['กำลังเรียก', 'call'], completed: ['มาบริจาคสำเร็จ', 'ok'], cancelled: ['ยกเลิก', 'bad'], no_show: ['ไม่มา', 'bad'] };
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
    ({ bookings, holidays, slots, usage, stats, export: exportTab, search, channels, settings })[S.tab]();
  }

  // ---------- 1) รายการจอง: รายสัปดาห์ (ภาพรวม) / รายวัน (เปลี่ยนสถานะ) ----------
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const mondayOf = (iso) => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
  // ปุ่มลัดขั้นถัดไปของแต่ละสถานะ: [สถานะถัดไป, ข้อความปุ่ม]
  const NEXT = { pending: ['confirmed', 'ยืนยัน (มาถึงแล้ว)'], confirmed: ['calling', 'เรียกคิว'], calling: ['completed', 'บริจาคสำเร็จ'] };
  const ACTIVE = ['pending', 'confirmed', 'calling', 'completed'];                 // นับเป็นคิวที่ใช้ที่นั่งจริง (เหมือนกติกาจองในฐานข้อมูล)

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
    const nmList = (list) => list.map((b) => `<div class="nm ${b.status}" title="${esc(STATUS[b.status][0])}">${esc(nameOf(b))}${b.status === 'completed' ? ' ✓' : b.status === 'no_show' ? ' ✗' : b.status === 'confirmed' ? ' ●' : b.status === 'calling' ? ' 🔔' : ''}</div>`).join('');

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
        <button class="btn sec sm" id="today">วันนี้</button>${stickerBar()}</div>
      <div id="list" class="mute">กำลังโหลด...</div>`;
    bindStickerBar();
    $('d').onchange = () => { S.date = $('d').value; bookings(); };
    const shift = (n) => { S.date = addDays(S.date, n); bookings(); };
    $('prev').onclick = () => shift(-1); $('next').onclick = () => shift(1);
    $('today').onclick = () => { S.date = bkkToday(); bookings(); };

    const [slotsR, bkR] = await Promise.all([
      sb.from('time_slots').select('id, label').order('start_time'),
      sb.from('bookings').select('id, user_id, status, time_slot_id, queue_no').eq('booking_date', S.date),
    ]);
    for (const r of [slotsR, bkR]) if (r.error) throw r.error;
    const longDate = fmt(S.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!bkR.data.length) { $('list').textContent = `ไม่มีรายการจองวัน${longDate}`; return; }
    const users = await loadUsers(bkR.data);

    const doneIds = bkR.data.filter((b) => b.status === 'completed').map((b) => b.id);
    const dons = new Map();
    if (doneIds.length) {
      const dr = await sb.from('donation_records').select('booking_id, bag_no, abo, rh, donated_on').in('booking_id', doneIds);
      if (dr.error) throw dr.error;
      dr.data.forEach((x) => dons.set(x.booking_id, x));
    }
    const counts = bkR.data.reduce((a, b) => (a[b.status] = (a[b.status] || 0) + 1, a), {});
    let html = `<p class="mute">${esc(longDate)} · รวม ${bkR.data.length} คิว
      (รอมา ${counts.pending || 0} · ยืนยัน ${counts.confirmed || 0} · กำลังเรียก ${counts.calling || 0} · สำเร็จ ${counts.completed || 0} · ไม่มา ${counts.no_show || 0} · ยกเลิก ${counts.cancelled || 0})</p>
      <table><tr><th>คิว</th><th>ชื่อ-นามสกุล</th><th>เบอร์โทร</th><th>สถานะ</th><th>เปลี่ยนสถานะ</th></tr>`;
    for (const s of slotsR.data) {
      const list = bkR.data.filter((b) => b.time_slot_id === s.id);
      if (!list.length) continue;
      html += `<tr><td colspan="5" class="slotname">${esc(s.label)} น.</td></tr>`;
      for (const b of list) {
        const u = users.get(b.user_id); const [t, c] = STATUS[b.status];
        html += `<tr><td>${b.queue_no ? 'B' + String(b.queue_no).padStart(3, '0') : '-'}</td><td>${esc(u?.full_name || u?.display_name || '(ไม่ระบุ)')}</td><td>${esc(u?.phone || '-')}</td>
          <td><span class="tag ${c}">${t}</span>${b.status === 'completed' ? bagCell(b.id, dons.get(b.id)) : ''}</td>
          <td>${b.status !== 'cancelled' && u ? `<button class="btn sec sm" data-stk="${b.user_id}" data-bk="${b.id}" title="พิมพ์สติ๊กเกอร์ติดใบยินยอม">🏷 สติ๊กเกอร์</button> ` : ''}${NEXT[b.status] ? `<button class="btn sm" data-next="${b.id}" data-to="${NEXT[b.status][0]}" data-cur="${b.status}">${NEXT[b.status][1]}</button> ` : ''}<select data-id="${b.id}" data-cur="${b.status}">${Object.entries(STATUS).map(([k, [n]]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${n}</option>`).join('')}</select></td></tr>`;
      }
    }
    $('list').className = '';
    $('list').innerHTML = html + '</table>';
    document.querySelectorAll('#list [data-bag]').forEach((btn) => (btn.onclick = () => {
      const b = bkR.data.find((x) => x.id === btn.dataset.bag); const u = users.get(b.user_id);
      donationForm(b.id, u?.full_name || u?.display_name || '', S.date, dons.get(b.id), bookings);
    }));
    const setStatus = async (id, to, cur, revert) => {
      if (to === 'completed' && !confirm('ยืนยัน "มาบริจาคสำเร็จ"? ระบบจะสร้างประวัติและเลขใบเกียรติบัตรให้ผู้บริจาค')) { revert && revert(); return; }
      const { error } = await sb.from('bookings').update({ status: to }).eq('id', id);
      if (error) { revert && revert(); return fail(error); }
      msg('อัปเดตสถานะแล้ว');
      if (to === 'completed') {   // เปิดฟอร์มกรอกเลขถุง/หมู่เลือด/Rh/วันบริจาคทันที (กด "ข้าม" เพื่อกรอกภายหลังได้)
        const b = bkR.data.find((x) => x.id === id); const u = users.get(b.user_id);
        donationForm(b.id, u?.full_name || u?.display_name || '', S.date, null, bookings);
      } else bookings();
    };
    document.querySelectorAll('#list [data-stk]').forEach((btn) => (btn.onclick = () => printSticker(btn.dataset.stk, btn.dataset.bk)));
    document.querySelectorAll('#list [data-next]').forEach((btn) => (btn.onclick = () => setStatus(btn.dataset.next, btn.dataset.to, btn.dataset.cur)));
    document.querySelectorAll('#list select').forEach((sel) => (sel.onchange = () => setStatus(sel.dataset.id, sel.value, sel.dataset.cur, () => { sel.value = sel.dataset.cur; })));
  }

  // ---------- สติ๊กเกอร์รายละเอียดผู้บริจาค 5×2 ซม. (เครื่องพิมพ์ Zebra ม้วนต่อเนื่อง) ----------
  // ข้อมูลมาจากฟังก์ชัน staff_sticker (เฉพาะเจ้าหน้าที่ · มีบันทึกการพิมพ์) · พิมพ์ผ่านหน้าต่างพิมพ์ของเบราว์เซอร์ ตั้งขนาดกระดาษ 50×20 มม.
  const STK = { W: 50, H: 20 };   // ขนาดสติ๊กเกอร์ (มม.) — แก้ที่นี่ถ้าเปลี่ยนม้วนสติ๊กเกอร์
  const GENDER_TH = { male: 'ชาย', female: 'หญิง', other: 'อื่น ๆ' };
  const fmtCid = (c) => (c && /^\d{13}$/.test(c) ? `${c[0]}-${c.slice(1, 5)}-${c.slice(5, 10)}-${c.slice(10, 12)}-${c[12]}` : c || '-');
  const thDMY = (d) => { if (!d) return '-'; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}/${m}/${Number(y) + 543}`; };
  const stickerCopies = () => { try { return Math.min(5, Math.max(1, Number(localStorage.getItem('stk_copies')) || 1)); } catch { return 1; } };
  const setStickerCopies = (n) => { try { localStorage.setItem('stk_copies', String(Math.min(5, Math.max(1, Number(n) || 1)))); } catch { /* ไม่เป็นไร */ } };
  const stickerHtml = (x) => {
    const name = x.full_name || '-';
    const nameCls = name.length > 24 ? 'n sm' : 'n';
    const q = x.queue_no ? `คิว B${String(x.queue_no).padStart(3, '0')}` : '';
    const line3 = [x.gender ? (GENDER_TH[x.gender] || '') : '', x.age != null ? `อายุ ${x.age} ปี` : '', x.birth_date ? `เกิด ${thDMY(x.birth_date)}` : ''].filter(Boolean).join(' · ');
    const line5 = [q, x.booking_date ? `นัด ${thDMY(x.booking_date)}` : ''].filter(Boolean).join(' · ');
    return `<div class="s"><div class="${nameCls}">${esc(name)}</div>
      <div class="r">บัตร ปชช. ${esc(fmtCid(x.cid))}</div>
      <div class="r">${esc(line3 || '-')}</div>
      <div class="r">โทร ${esc(x.phone || '-')}</div>${line5 ? `<div class="r">${esc(line5)}</div>` : ''}</div>`;
  };
  const stickerPage = (items, copies) => {
    const one = items.map(stickerHtml).join('');
    const pages = Array.from({ length: copies }, () => one).join('');
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title> </title><style>
      @page { size: ${STK.W}mm ${STK.H}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body { font-family: 'Sarabun','Leelawadee UI','Tahoma','Noto Sans Thai',sans-serif; color: #000; }
      .s { width: ${STK.W}mm; height: ${STK.H}mm; box-sizing: border-box; padding: 1.4mm 2mm; overflow: hidden; page-break-after: always; break-after: page; }
      .s:last-child { page-break-after: auto; break-after: auto; }
      .n { font-size: 9.5pt; font-weight: 700; line-height: 1.2; white-space: nowrap; overflow: hidden; }
      .n.sm { font-size: 8pt; }
      .r { font-size: 7.2pt; line-height: 1.3; white-space: nowrap; overflow: hidden; }
    </style></head><body>${pages}</body></html>`;
  };
  const printHtml = (html) => {
    const f = document.createElement('iframe');
    f.id = 'stkframe'; f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(f);
    const d = f.contentDocument; d.open(); d.write(html); d.close();
    setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { fail(e); } }, 350);
    setTimeout(() => f.remove(), 120000);
  };
  async function printSticker(userId, bookingId) {
    const copies = stickerCopies();
    msg('กำลังเตรียมสติ๊กเกอร์...');
    const { data, error } = await sb.rpc('staff_sticker', { p_user: userId, p_booking: bookingId || null, p_copies: copies });
    if (error) return fail(error);
    const x = Array.isArray(data) ? data[0] : data;
    if (!x) return msg('พิมพ์ไม่ได้: ผู้บริจาคลบข้อมูลหรือยังไม่ได้ยินยอมนโยบาย', true);
    msg(`ส่งสติ๊กเกอร์ ${copies} ดวงไปหน้าต่างพิมพ์แล้ว (เลือกเครื่องพิมพ์ Zebra, ขนาดกระดาษ ${STK.W}×${STK.H} มม.)`);
    printHtml(stickerPage([x], copies));
  }
  const stickerTest = () => {   // ข้อมูลสมมติ ไม่เรียกฐานข้อมูล ใช้ตั้งค่าเครื่องพิมพ์/ตรวจตำแหน่ง
    printHtml(stickerPage([{ full_name: 'นายทดสอบ สติ๊กเกอร์', cid: '1234567890123', birth_date: '1990-05-01', age: 36, gender: 'male', phone: '081-234-5678', queue_no: 7, booking_date: bkkToday() }], 1));
  };
  const stickerBar = () => `<span class="mute" style="margin-left:8px">สติ๊กเกอร์ต่อคน
    <input type="number" id="stkn" min="1" max="5" value="${stickerCopies()}" style="width:54px"> ดวง</span>
    <button class="btn sec sm" id="stktest" title="พิมพ์สติ๊กเกอร์ตัวอย่าง (ข้อมูลสมมติ) เพื่อตั้งค่าเครื่องพิมพ์ Zebra">ทดสอบพิมพ์สติ๊กเกอร์</button>`;
  const bindStickerBar = () => {
    const n = $('stkn'); if (n) n.onchange = () => { setStickerCopies(n.value); n.value = stickerCopies(); };
    const t = $('stktest'); if (t) t.onclick = stickerTest;
  };

  // ---------- ข้อมูลถุงเลือดของการบริจาคที่สำเร็จ ----------
  const RH_TH = { pos: 'Rh+', neg: 'Rh−' };
  const bagCell = (id, d) => `<div class="mute" style="margin-top:4px">${d?.bag_no ? `ถุง ${esc(d.bag_no)} · ${esc(d.abo)} ${RH_TH[d.rh] || ''}` : '<span style="color:var(--warn)">ยังไม่กรอกข้อมูลถุงเลือด</span>'}
    <button class="btn sec sm" data-bag="${id}">${d?.bag_no ? 'แก้ไข' : 'กรอกข้อมูลถุงเลือด'}</button></div>`;
  const RPC_ERR = { BAG_INVALID: 'เลขถุงไม่ถูกต้อง (ตัวอักษร/ตัวเลข/ขีด 3-30 ตัว)', BAG_DUPLICATE: 'เลขถุงนี้ถูกใช้กับผู้บริจาคคนอื่นแล้ว — ตรวจสอบเลขถุงอีกครั้ง',
    ABO_INVALID: 'กรุณาเลือกหมู่เลือด', RH_INVALID: 'กรุณาเลือก Rh', DATE_INVALID: 'วันบริจาคไม่ถูกต้อง (ห้ามเป็นวันในอนาคต)', DONATION_NOT_FOUND: 'ไม่พบรายการบริจาค — ต้องตั้งสถานะ "มาบริจาคสำเร็จ" ก่อน' };
  const rpcMsg = (e) => RPC_ERR[Object.keys(RPC_ERR).find((k) => (e.message || '').includes(k))] || e.message;

  function donationForm(bookingId, name, bookingDate, d, after) {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="card" style="max-width:420px;width:100%">
      <h2>ข้อมูลถุงเลือด</h2><p class="mute">ผู้บริจาค: ${esc(name || '-')}</p>
      <div id="fmsg"></div>
      <label>เลขถุงเลือด <input id="fbag" type="text" maxlength="30" autocomplete="off" value="${esc(d?.bag_no || '')}" style="width:100%"></label>
      <div class="row" style="margin-top:8px">
        <label>หมู่เลือด <select id="fabo"><option value="">เลือก</option>${['A', 'B', 'AB', 'O'].map((x) => `<option ${d?.abo === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>Rh <select id="frh"><option value="">เลือก</option><option value="pos" ${d?.rh === 'pos' ? 'selected' : ''}>Rh บวก (+)</option><option value="neg" ${d?.rh === 'neg' ? 'selected' : ''}>Rh ลบ (−)</option></select></label></div>
      <label>วันบริจาคจริง <input id="fdate" type="date" max="${bkkToday()}" value="${d?.donated_on || (bookingDate <= bkkToday() ? bookingDate : bkkToday())}"></label>
      <div class="row" style="margin-top:12px"><button class="btn" id="fsave">บันทึก</button><button class="btn sec" id="fskip">${d ? 'ปิด' : 'ข้าม (กรอกภายหลัง)'}</button></div></div>`;
    document.body.appendChild(m);
    const close = () => { m.remove(); after(); };
    $('fskip').onclick = close;
    $('fsave').onclick = async () => {
      const { error } = await sb.rpc('save_donation_details', { p_booking: bookingId, p_bag: $('fbag').value, p_abo: $('fabo').value, p_rh: $('frh').value, p_donated_on: $('fdate').value });
      if (error) { $('fmsg').innerHTML = `<div class="msg err">${esc(rpcMsg(error))}</div>`; return; }
      m.remove(); msg('บันทึกข้อมูลถุงเลือดแล้ว'); after();
    };
    $('fbag').focus();
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
  const EXP_STATUS = [['', 'ทุกสถานะ'], ['completed', 'เฉพาะ: มาบริจาคสำเร็จ'], ['pending', 'เฉพาะ: รอยืนยัน'], ['confirmed', 'เฉพาะ: ยืนยัน'], ['calling', 'เฉพาะ: กำลังเรียก'], ['cancelled', 'เฉพาะ: ยกเลิก'], ['no_show', 'เฉพาะ: ไม่มา']];
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
          ['cid', 'donated_on', 'certificate_no', 'booking_id', 'donor_ref', 'bag_no', 'abo', 'rh'],
          (x, ex) => [c(x.cid, { phone: true, excel: ex }), c(x.donated_on), c(x.certificate_no), c(x.booking_id), c(x.donor_ref), c(x.bag_no), c(x.abo), c(x.rh === 'pos' ? 'POS' : x.rh === 'neg' ? 'NEG' : '')], r);
      };
    }
    if (isAdmin) loadHist();
  }

  // ---------- 5) ค้นหาผู้บริจาค ----------
  function search() {
    $('view').innerHTML = `<div class="card"><h2>ค้นหาผู้บริจาค</h2>
      <div class="row"><input id="q" placeholder="ชื่อ-นามสกุล หรือ LINE User ID" style="min-width:280px"><button class="btn" id="go">ค้นหา</button></div>
      <div class="row" style="margin-top:6px">${stickerBar()}</div>
      <div id="res" class="mute">พิมพ์อย่างน้อย 2 ตัวอักษร</div></div><div id="detail"></div>`;
    bindStickerBar();
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
            <td><button class="btn sec sm" data-u="${u.id}">ดูประวัติ</button> <button class="btn sec sm" data-stk="${u.id}" title="พิมพ์สติ๊กเกอร์ติดใบยินยอม">🏷 สติ๊กเกอร์</button></td></tr>`).join('')}</table>` : 'ไม่พบข้อมูล';
      document.querySelectorAll('#res [data-u]').forEach((b) => (b.onclick = () => detail(data.find((u) => u.id === b.dataset.u))));
      document.querySelectorAll('#res [data-stk]').forEach((b) => (b.onclick = () => printSticker(b.dataset.stk, null)));
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
    ['usage_notice_include_ward', false, 'ใส่ชื่อหอผู้ป่วยในข้อความ "เลือดของคุณถูกใช้แล้ว"', 'ปิดไว้เป็นค่าเริ่มต้น เพราะอาจทำให้ระบุตัวผู้ป่วยได้ — ให้ DPO/ผู้รับผิดชอบยืนยันก่อนเปิด'],
    ['notify_status_change',   false, 'แจ้งเมื่อเจ้าหน้าที่เปลี่ยนสถานะ (ยืนยัน / สำเร็จ / ยกเลิก / ไม่มา)', 'ผู้บริจาคดูสถานะได้เองในหน้า LIFF > ประวัติ'],
    ['notify_called',          true,  'แจ้ง "ถึงคิวของคุณแล้ว" เมื่อเจ้าหน้าที่กด "เรียกคิว"', 'ผู้บริจาคไม่ต้องเฝ้าหน้าจอทีวี · 1 ข้อความต่อคิว (เปิดไว้เป็นค่าเริ่มต้น)'],
    ['notify_recall',          true,  'ชวนกลับมาบริจาคเมื่อครบ 3 เดือนนับจากครั้งล่าสุด', 'ส่ง 1 ข้อความต่อผู้บริจาคต่อรอบ (ตรวจทุก 08:00 น.) · ผู้บริจาคปิดรับเองได้ที่ "ข้อมูลของฉัน" · ให้ DPO ยืนยันข้อความก่อนใช้จริง'],
    ['notify_birthday',        true,  'อวยพรวันเกิดผู้บริจาค + ชวนมาบริจาคเป็นสิริมงคล', 'ส่งปีละ 1 ข้อความ เฉพาะผู้ที่เคยบริจาคสำเร็จและให้ความยินยอมแล้ว · ประหยัดโควตาได้ด้วยช่องทาง MOPH Alert'],
  ];
  const CHANNELS = [
    ['line', 'LINE OA (ใช้โควตาข้อความ push ของ LINE OA)'],
    ['moph_alert', 'MOPH Alert (หมอพร้อม) อย่างเดียว — ไม่ใช้โควตา LINE OA'],
    ['moph_alert_then_line', 'MOPH Alert ก่อน ถ้าส่งไม่สำเร็จค่อยส่งทาง LINE'],
  ];
  const tvUrl = (t) => (t ? location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '') + 'tv.html?k=' + encodeURIComponent(t) : '(ยังไม่ได้รัน v8.sql)');
  async function settings() {
    const { data, error } = await sb.from('app_settings').select('key, value');
    if (error) return fail({ message: 'อ่านการตั้งค่าไม่ได้ — ยังไม่ได้รันไฟล์ settings.sql ใน Supabase หรือไม่? (' + error.message + ')' });
    const raw = Object.fromEntries(data.map((r) => [r.key, r.value]));
    const cur = Object.fromEntries(data.map((r) => [r.key, r.value === 'true']));
    $('view').innerHTML = `<div class="card"><h2>ช่องทางแจ้งผู้บริจาค</h2>
      <p class="mute">เลือกว่าข้อความถึงผู้บริจาคจะส่งทางใด · MOPH Alert ส่งโดยใช้เลขบัตรประชาชนที่ผู้บริจาคกรอก (ต้องตั้ง Secrets client-key/secret-key ของ MOPH Alert ในฟังก์ชันก่อน — ดูคู่มือ "อัปเดต v5")
      ผู้ที่ไม่ได้ลงทะเบียนไลน์หมอพร้อมด้วยเลขบัตรนี้จะส่งไม่ถึง (404) — แนะนำโหมด "ก่อน ... แล้วค่อย LINE"</p>
      <select id="donorch">${CHANNELS.map(([k, t]) => `<option value="${k}" ${(raw.donor_channel || 'line') === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <div class="row" style="margin-top:10px"><label>ทดสอบ MOPH Alert: ส่งหาเลขบัตรของคุณเอง <input id="alertcid" type="text" inputmode="numeric" maxlength="17" placeholder="13 หลัก"></label>
        <button class="btn sec sm" id="alerttest">ส่งทดสอบ</button></div></div>
      <div class="card"><h2>ตั้งค่าการแจ้งเตือนผู้บริจาค</h2>
      <p class="mute">ทุกข้อความที่ส่งหาผู้บริจาคทาง LINE จะหักโควตาข้อความของ LINE OA ตามแพ็กเกจของคุณ — เปิดเฉพาะที่จำเป็น
      (ตรวจโควตาที่เหลือได้ใน LINE OA Manager) · การแจ้งเจ้าหน้าที่ผ่านหมอพร้อมไม่ใช้โควตานี้และไม่ได้รับผลจากหน้านี้</p>
      ${DONOR_NOTIFY.map(([k, def, label, hint]) => `<label class="sw"><input type="checkbox" data-key="${k}" ${(k in cur ? cur[k] : def) ? 'checked' : ''}>
        <span><b>${esc(label)}</b><br><small class="mute">${esc(hint)}</small></span></label>`).join('')}
      <div class="row" style="margin-top:12px"><button class="btn" id="savesettings">บันทึกการตั้งค่า</button></div></div>
      <div class="card"><h2>หน้าจอทีวี / มอนิเตอร์ห้องรอ</h2>
      <p class="mute">เปิดลิงก์นี้ในเบราว์เซอร์ของเครื่องที่ต่อทีวี แล้วกด F11 (เต็มจอ) · แสดงเฉพาะหมายเลขคิว และชื่อต้น+อักษรย่อนามสกุลของผู้ที่ติ๊กยินยอมเท่านั้น
      (ไม่มีเลขบัตร เบอร์โทร หมู่เลือด) · ใครมีลิงก์ก็เปิดดูได้ จึงไม่ควรเผยแพร่ลิงก์ — ถ้าหลุดให้กด "สร้างลิงก์ใหม่"</p>
      <input id="tvlink" type="text" readonly style="width:100%" value="${esc(tvUrl(raw.tv_token))}">
      <div class="row" style="margin-top:10px"><button class="btn sec sm" id="tvcopy">คัดลอกลิงก์</button>
        <a class="btn sec sm" id="tvopen" href="${esc(tvUrl(raw.tv_token))}" target="_blank" rel="noopener">เปิดดูตัวอย่าง</a>
        <button class="btn sec sm" id="tvreset">สร้างลิงก์ใหม่</button></div></div>`;
    $('tvcopy').onclick = async () => { try { await navigator.clipboard.writeText($('tvlink').value); msg('คัดลอกแล้ว'); } catch { $('tvlink').select(); msg('กด Ctrl+C เพื่อคัดลอก'); } };
    $('tvreset').onclick = async () => {
      if (!confirm('สร้างลิงก์ใหม่? ลิงก์เดิมที่เปิดอยู่บนทีวีจะใช้ไม่ได้ ต้องเปิดลิงก์ใหม่บนเครื่องทีวี')) return;
      const t = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
      const { error: e } = await sb.from('app_settings').upsert({ key: 'tv_token', value: t }, { onConflict: 'key' });
      e ? fail(e) : (msg('สร้างลิงก์ใหม่แล้ว'), settings());
    };
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

  // ---------- การใช้เลือด: นำเข้าไฟล์ (CSV/Excel) แล้วแจ้งผู้บริจาคว่าเลือดถูกใช้ช่วยชีวิตแล้ว ----------
  const U_FIELDS = [
    ['bag_no', 'เลขถุงเลือด *', ['เลขถุง', 'หมายเลขถุง', 'bag', 'unit no', 'unitno', 'donation']],
    ['request_no', 'เลขที่ใบขอเลือด *', ['ใบขอ', 'เลขที่ขอ', 'request', 'req']],
    ['used_on', 'วันที่ใช้ *', ['วันที่ใช้', 'วันที่จ่าย', 'used', 'issue', 'จ่าย', 'วันที่']],
    ['component', 'ชนิดส่วนประกอบเลือด (ถ้ามี)', ['ชนิด', 'ส่วนประกอบ', 'component', 'product', 'prc']],
    ['ward', 'หอผู้ป่วย (ถ้ามี)', ['หอ', 'ward', 'ตึก']],
  ];
  const U = { rows: [], headers: [], map: {}, batch: null };

  // อ่าน CSV (รองรับ BOM, เครื่องหมายคำพูด, คั่นด้วย , ; หรือ Tab)
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((x, y) => y[1] - x[1])[0][0];
    const out = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter((r) => r.some((x) => String(x).trim() !== ''));
  }

  // แปลงวันที่หลายรูปแบบ -> YYYY-MM-DD (รองรับ พ.ศ., dd/mm/yyyy, serial ของ Excel)
  function parseDateAny(s) {
    s = String(s ?? '').trim(); if (!s) return null;
    let y, m, d, x;
    if ((x = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [y, m, d] = [x[1], x[2], x[3]];
    else if ((x = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) [d, m, y] = [x[1], x[2], x[3]];
    else if (/^\d{5}$/.test(s)) { const t = new Date(Date.UTC(1899, 11, 30) + Number(s) * 864e5); [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
    else return null;
    y = Number(y); m = Number(m); d = Number(d);
    if (y < 100) y += 2000; if (y > 2400) y -= 543;
    const t = new Date(Date.UTC(y, m - 1, d));
    if (y < 2000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }

  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('โหลดตัวอ่าน Excel ไม่ได้ — ให้บันทึกไฟล์เป็น CSV UTF-8 แล้วลองใหม่')); document.head.appendChild(s); });
  async function readTable(file) {
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' }).filter((r) => r.some((x) => String(x).trim() !== ''));
    }
    return parseCsv(await file.text());
  }

  const callUsage = async (body) => {
    const { data: ss } = await sb.auth.getSession();
    const res = await fetch(`${C.FUNCTIONS_URL}/usage-notify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ss.session.access_token}`, apikey: C.SUPABASE_ANON_KEY }, body: JSON.stringify(body),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 404 ? 'ยังไม่ได้ Deploy ฟังก์ชัน usage-notify (ดูคู่มือ "อัปเดตครั้งที่ 7")' : (r.error || `HTTP ${res.status}`));
    return r;
  };

  async function usage() {
    const t = await sb.from('blood_usage').select('id', { head: true, count: 'exact' });
    if (t.error) return fail({ message: 'ยังไม่ได้รันไฟล์ usage.sql ใน Supabase (ดูคู่มือ "อัปเดตครั้งที่ 7")' });
    $('view').innerHTML = `<div class="card"><h2>นำเข้าข้อมูลการใช้เลือด</h2>
      <p class="mute">เลือกไฟล์ CSV หรือ Excel (.xlsx) จากงานธนาคารเลือด ที่มี <b>เลขถุงเลือด · เลขที่ใบขอเลือด · วันที่ใช้</b> (ชนิดส่วนประกอบ/หอผู้ป่วยเป็นทางเลือก)
      ระบบจับคู่ผู้บริจาคด้วยเลขถุง · อ่านเฉพาะคอลัมน์ที่เลือกจับคู่ — <b>คอลัมน์อื่น (เช่น HN, ชื่อผู้ป่วย) ไม่ถูกอ่านเก็บ</b></p>
      <div class="drop"><input type="file" id="ufile" accept=".csv,.txt,.xlsx,.xls"> <button class="btn sec sm" id="utpl">ดาวน์โหลดไฟล์ตัวอย่าง</button></div>
      <div id="umap"></div></div>
      <div class="card" id="upend"><h2>รอแจ้งผู้บริจาค</h2><div class="mute">กำลังตรวจสอบ...</div></div>
      <div class="card"><h2>รายการนำเข้าล่าสุด</h2><div id="ulist" class="mute">กำลังโหลด...</div></div>`;
    $('utpl').onclick = () => {
      const blob = new Blob(['﻿bag_no,request_no,used_on,component,ward\r\nA1234567,REQ-001,2026-11-18,PRC,\r\n'], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'blood_usage_template.csv'; a.click();
    };
    $('ufile').onchange = async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try {
        const tbl = await readTable(f);
        if (tbl.length < 2) return msg('ไฟล์ไม่มีข้อมูล', true);
        if (tbl.length > 20001) return msg('ไฟล์ใหญ่เกิน 20,000 แถว กรุณาแบ่งไฟล์', true);
        U.headers = tbl[0].map((h) => String(h).trim()); U.rows = tbl.slice(1); U.map = {}; U.batch = null;
        U_FIELDS.forEach(([k, , kw]) => {
          const i = U.headers.findIndex((h) => kw.some((w) => h.toLowerCase().includes(w)));
          U.map[k] = i >= 0 && !Object.values(U.map).includes(i) ? i : -1;
        });
        msg(''); renderMap();
      } catch (e) { fail(e); }
    };
    usageStatus();
  }

  function mapped() {
    const g = (r, k) => (U.map[k] >= 0 ? String(r[U.map[k]] ?? '').trim() : '');
    const ok = [], bad = [];
    U.rows.forEach((r, i) => {
      const o = { bag_no: g(r, 'bag_no'), request_no: g(r, 'request_no'), used_on: parseDateAny(g(r, 'used_on')), component: g(r, 'component'), ward: g(r, 'ward') };
      (o.bag_no && o.request_no && o.used_on ? ok : bad).push(o.bag_no && o.request_no && o.used_on ? o : { ...o, line: i + 2 });
    });
    return { ok, bad };
  }

  function renderMap() {
    const opts = (sel) => `<option value="-1">— ไม่ใช้ —</option>${U.headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || '(คอลัมน์ ' + (i + 1) + ')')}</option>`).join('')}`;
    const { ok, bad } = mapped();
    const need = ['bag_no', 'request_no', 'used_on'].every((k) => U.map[k] >= 0);
    $('umap').innerHTML = `<h3>จับคู่คอลัมน์ในไฟล์ (พบ ${U.rows.length} แถว)</h3>
      <div class="row">${U_FIELDS.map(([k, label]) => `<label>${esc(label)}<br><select data-m="${k}">${opts(U.map[k])}</select></label>`).join('')}</div>
      ${need ? `<p>ตรวจแล้ว: <span class="tag ok">ใช้ได้ ${ok.length} แถว</span> ${bad.length ? `<span class="tag bad">ข้าม ${bad.length} แถว (ข้อมูลไม่ครบ/วันที่ไม่ถูกต้อง)</span>` : ''}</p>
        <div class="tblwrap"><table><tr><th>เลขถุง</th><th>เลขที่ใบขอ</th><th>วันที่ใช้</th><th>ชนิด</th><th>หอผู้ป่วย</th></tr>
        ${ok.slice(0, 5).map((o) => `<tr><td>${esc(o.bag_no)}</td><td>${esc(o.request_no)}</td><td>${esc(fmt(o.used_on, { day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${esc(o.component || '-')}</td><td>${esc(o.ward || '-')}</td></tr>`).join('')}</table></div>
        <p class="mute">ตัวอย่าง 5 แถวแรก — ตรวจว่าวันที่ถูกต้อง (ระบบอ่านปี พ.ศ./ค.ศ. ได้ทั้งคู่)</p>
        <button class="btn" id="udo" ${ok.length ? '' : 'disabled'}>นำเข้า ${ok.length} แถว</button>`
        : '<div class="msg err">กรุณาเลือกคอลัมน์ที่มีเครื่องหมาย * ให้ครบทั้ง 3 อย่าง</div>'}
      <div id="ures"></div>`;
    document.querySelectorAll('[data-m]').forEach((s) => (s.onchange = () => { U.map[s.dataset.m] = Number(s.value); renderMap(); }));
    if ($('udo')) $('udo').onclick = doImport;
  }

  async function doImport() {
    const { ok } = mapped(); const btn = $('udo'); btn.disabled = true;
    const batch = crypto.randomUUID(); const tot = { inserted: 0, duplicate: 0, invalid: 0, matched: 0, unmatched: 0 };
    try {
      for (let i = 0; i < ok.length; i += 500) {
        btn.textContent = `กำลังนำเข้า ${Math.min(i + 500, ok.length)}/${ok.length}...`;
        const { data, error } = await sb.rpc('import_blood_usage', { p_rows: ok.slice(i, i + 500), p_batch: batch });
        if (error) throw error;
        Object.keys(tot).forEach((k) => (tot[k] += data[k] || 0));
      }
      U.batch = batch;
      $('ures').innerHTML = `<div class="msg">นำเข้าเสร็จ: เพิ่มใหม่ ${tot.inserted} · ซ้ำ(ข้าม) ${tot.duplicate} · ข้อมูลไม่ถูกต้อง ${tot.invalid} ·
        จับคู่ผู้บริจาคได้ <b>${tot.matched}</b> · ไม่พบเลขถุงในระบบนี้ ${tot.unmatched}</div>
        ${tot.unmatched ? '<p class="mute">"ไม่พบเลขถุง" มักเป็นเลือดจากผู้บริจาคที่ไม่ได้จองผ่านระบบนี้ หรือยังไม่ได้กรอกเลขถุงในรายการจอง — กรอกภายหลังแล้วระบบจะจับคู่ให้อัตโนมัติ</p>' : ''}
        ${S.me.role === 'admin' && tot.inserted ? '<button class="btn sec sm" id="uundo">ยกเลิกชุดนี้ (นำเข้าผิดไฟล์)</button>' : ''}`;
      btn.remove(); U.rows = []; $('ufile').value = '';
      if ($('uundo')) $('uundo').onclick = async () => {
        if (!confirm('ลบรายการของชุดที่เพิ่งนำเข้านี้? (ลบได้เฉพาะรายการที่ยังไม่ได้แจ้งผู้บริจาค)')) return;
        const r = await sb.rpc('delete_usage_batch', { p_batch: batch });
        r.error ? fail(r.error) : (msg(`ลบแล้ว ${r.data} รายการ`), usage());
      };
      usageStatus();
    } catch (e) { btn.disabled = false; fail({ message: (e.message || e) + ' — ถ้านำเข้าไปบางส่วนแล้ว ให้ส่งไฟล์เดิมซ้ำได้ ระบบข้ามรายการที่มีอยู่แล้ว' }); }
  }

  async function usageStatus() {
    let pend = 0;
    try { pend = (await callUsage({ action: 'preview' })).pending; } catch (e) { $('upend').innerHTML = `<h2>รอแจ้งผู้บริจาค</h2><div class="msg err">${esc(e.message)}</div>`; }
    if ($('upend') && !$('upend').querySelector('.err')) {
      $('upend').innerHTML = `<h2>รอแจ้งผู้บริจาค: ${pend} ราย</h2>
        <p class="mute">ข้อความ: "เลือดของคุณได้ช่วยชีวิตผู้ป่วยแล้ว — ใบขอเลือดเลขที่ … ใช้เมื่อวันที่ …" (ไม่มีชื่อผู้ป่วย) · ส่งตามช่องทางที่ตั้งไว้ (แท็บ "แจ้งเตือนผู้บริจาค") · ถ้าใช้ LINE จะหักโควตา 1 ข้อความต่อราย · แต่ละรายส่งได้ครั้งเดียว</p>
        <button class="btn" id="usend" ${pend ? '' : 'disabled'}>ส่งแจ้งเตือนผู้บริจาค ${pend} ราย</button><div id="usres" style="margin-top:8px"></div>`;
      $('usend').onclick = async () => {
        if (!confirm(`ส่งข้อความ "เลือดของคุณถูกใช้แล้ว" ให้ผู้บริจาค ${pend} ราย?`)) return;
        $('usend').disabled = true; const sum = { sent: 0, skipped: 0, failed: 0 };
        try {
          for (let guard = 0; guard < 600; guard++) {
            const r = await callUsage({ action: 'send' });
            sum.sent += r.sent; sum.skipped += r.skipped; sum.failed += r.failed;
            $('usres').textContent = `กำลังส่ง... ส่งแล้ว ${sum.sent} · ข้าม ${sum.skipped} · ไม่สำเร็จ ${sum.failed} · คงเหลือ ${r.remaining}`;
            if (!r.remaining || r.stalled) break;
          }
          msg(`เสร็จสิ้น: ส่งแล้ว ${sum.sent} · ข้าม(ผู้บริจาคลบข้อมูลแล้ว) ${sum.skipped} · ไม่สำเร็จ ${sum.failed}${sum.failed ? ' — ตรวจช่องทาง/Secrets แล้วกดส่งใหม่ได้ (รายที่สำเร็จแล้วจะไม่ถูกส่งซ้ำ)' : ''}`, sum.failed > 0);
        } catch (e) { fail(e); }
        usageStatus(); usageList();
      };
    }
    usageList();
  }

  async function usageList() {
    const { data, error } = await sb.from('blood_usage').select('bag_no, request_no, used_on, component, donation_id, notify_status, created_at').order('created_at', { ascending: false }).limit(50);
    if (error) return ($('ulist').textContent = error.message);
    $('ulist').className = '';
    $('ulist').innerHTML = data.length ? `<div class="tblwrap"><table><tr><th>เลขถุง</th><th>ใบขอเลือด</th><th>วันที่ใช้</th><th>ชนิด</th><th>ผู้บริจาค</th><th>แจ้งแล้ว</th></tr>
      ${data.map((x) => `<tr><td>${esc(x.bag_no)}</td><td>${esc(x.request_no)}</td><td>${esc(fmt(x.used_on, { day: 'numeric', month: 'short', year: 'numeric' }))}</td><td>${esc(x.component || '-')}</td>
        <td>${x.donation_id ? '<span class="tag ok">จับคู่แล้ว</span>' : '<span class="tag warn">ไม่พบเลขถุง</span>'}</td>
        <td>${x.notify_status === 'sent' ? '<span class="tag ok">ส่งแล้ว</span>' : x.notify_status === 'skipped' ? '<span class="tag">ข้าม</span>' : '-'}</td></tr>`).join('')}</table></div>
      <p class="mute">แสดง 50 รายการล่าสุด</p>` : 'ยังไม่มีข้อมูลการใช้เลือด';
  }

  boot();
})();
