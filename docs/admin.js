// แดชบอร์ดเจ้าหน้าที่: ล็อกอินด้วย Supabase Auth, สิทธิ์ควบคุมด้วย RLS ฝั่งฐานข้อมูล
// (หน้านี้ใช้ anon key เท่านั้น - ถ้าไม่ใช่ผู้ใช้ใน admin_users จะอ่าน/เขียนข้อมูลไม่ได้)
(() => {
  'use strict';
  const C = window.CONFIG;
  const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY);
  const root = document.getElementById('root');

  const S = { me: null, tab: 'bookings', date: bkkToday(), year: new Date().getFullYear() };
  const TABS = [['bookings', 'รายการจอง'], ['holidays', 'วันหยุด'], ['slots', 'ช่วงเวลา/ขีดจำกัดคิว'],
                ['stats', 'สถิติ'], ['search', 'ค้นหาผู้บริจาค'], ['channels', 'ห้องแจ้งเตือน (หมอพร้อม)']];
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
    const tabs = TABS.filter(([k]) => k !== 'channels' || S.me.role === 'admin');
    root.innerHTML = `
      <header><div><b>🩸 ธนาคารเลือด รพ.อ่างทอง</b><br><small>${esc(S.me.display_name)} (${S.me.role === 'admin' ? 'ผู้ดูแล' : 'เจ้าหน้าที่'})</small></div>
        <button class="btn sec sm" id="out" style="background:#fff">ออกจากระบบ</button></header>
      <nav>${tabs.map(([k, t]) => `<button data-t="${k}" class="${S.tab === k ? 'on' : ''}">${t}</button>`).join('')}</nav>
      <main><div id="msg"></div><div id="view"></div></main>`;
    $('out').onclick = async () => { await sb.auth.signOut(); loginView(); };
    document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { S.tab = b.dataset.t; shell(); }));
    ({ bookings, holidays, slots, stats, search, channels })[S.tab]();
  }

  // ---------- 1) รายการจอง + อัปเดตสถานะ ----------
  async function bookings() {
    $('view').innerHTML = `<div class="card"><h2>รายการจอง</h2>
      <div class="row"><input type="date" id="d" value="${S.date}">
        <button class="btn sec sm" id="prev">◀ วันก่อน</button><button class="btn sec sm" id="next">วันถัดไป ▶</button>
        <button class="btn sec sm" id="today">วันนี้</button></div>
      <div id="list" class="mute">กำลังโหลด...</div></div>`;
    $('d').onchange = () => { S.date = $('d').value; bookings(); };
    const shift = (n) => { const d = new Date(S.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); S.date = d.toISOString().slice(0, 10); bookings(); };
    $('prev').onclick = () => shift(-1); $('next').onclick = () => shift(1);
    $('today').onclick = () => { S.date = bkkToday(); bookings(); };

    const { data, error } = await sb.from('bookings')
      .select('id, status, time_slot_id, time_slots(label, start_time), users(full_name, phone, display_name)')
      .eq('booking_date', S.date).order('time_slot_id');
    if (error) return fail(error);
    if (!data.length) { $('list').textContent = `ไม่มีรายการจองวัน${fmt(S.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`; return; }

    const counts = data.reduce((a, b) => (a[b.status] = (a[b.status] || 0) + 1, a), {});
    let html = `<p class="mute">${fmt(S.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · รวม ${data.length} คิว
      (รอ ${counts.pending || 0} · สำเร็จ ${counts.completed || 0} · ไม่มา ${counts.no_show || 0} · ยกเลิก ${counts.cancelled || 0})</p>
      <table><tr><th>ชื่อ-นามสกุล</th><th>เบอร์โทร</th><th>สถานะ</th><th>เปลี่ยนสถานะ</th></tr>`;
    let last = null;
    for (const b of data) {
      if (b.time_slots?.label !== last) { last = b.time_slots?.label; html += `<tr><td colspan="4" class="slotname">${esc(last)} น.</td></tr>`; }
      const [t, c] = STATUS[b.status];
      html += `<tr><td>${esc(b.users?.full_name || b.users?.display_name || '(ไม่ระบุ)')}</td><td>${esc(b.users?.phone || '-')}</td>
        <td><span class="tag ${c}">${t}</span></td>
        <td><select data-id="${b.id}" data-cur="${b.status}">${Object.entries(STATUS).map(([k, [n]]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${n}</option>`).join('')}</select></td></tr>`;
    }
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
      <div class="row"><label>ปี (ค.ศ.) <input type="number" id="y" value="${S.year}" min="2020" max="2100"></label>
        <button class="btn sec sm" id="all">ทุกปี</button><button class="btn sm" id="go">ดู</button></div>
      <div id="out" class="mute">กำลังโหลด...</div></div>`;
    $('go').onclick = () => { S.year = Number($('y').value); stats(); };
    $('all').onclick = () => { S.year = null; stats(); };
    const { data, error } = await sb.rpc('stats_monthly', { p_year: S.year });
    if (error) return fail(error);
    if (!data.length) { $('out').textContent = 'ไม่มีข้อมูลในช่วงที่เลือก'; return; }
    const max = Math.max(...data.map((r) => r.booked), 1);
    const tot = data.reduce((a, r) => ({ b: a.b + r.booked, c: a.c + r.completed, x: a.x + r.cancelled, n: a.n + r.no_show }), { b: 0, c: 0, x: 0, n: 0 });
    $('out').innerHTML = `<p><b>รวม:</b> จอง ${tot.b} · มาบริจาคสำเร็จ ${tot.c} · ยกเลิก ${tot.x} · ไม่มา ${tot.n}</p>
      <table><tr><th>เดือน</th><th>จอง</th><th>บริจาคสำเร็จ</th><th>ยกเลิก</th><th>ไม่มา</th><th style="width:30%"></th></tr>
      ${data.map((r) => `<tr><td>${esc(fmt(r.month, { month: 'long', year: 'numeric' }))}</td><td>${r.booked}</td><td>${r.completed}</td><td>${r.cancelled}</td><td>${r.no_show}</td>
        <td><div class="bar" style="width:${(r.booked / max) * 100}%"></div><div class="bar g" style="width:${(r.completed / max) * 100}%;margin-top:2px"></div></td></tr>`).join('')}</table>
      <p class="mute">แถบแดง = จอง · แถบเขียว = บริจาคสำเร็จ</p>`;
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

  boot();
})();
