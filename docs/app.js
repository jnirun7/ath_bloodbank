// หน้าจอ LIFF : ยินยอม PDPA -> คัดกรอง -> เลือกคิว -> ยืนยัน -> ประวัติ / ลบข้อมูล
(() => {
  'use strict';
  const C = window.CONFIG;
  const DISCLAIMER = 'ผลการคัดกรองนี้เป็นเพียงการตรวจเบื้องต้นเท่านั้น ยังต้องตรวจสุขภาพจริงที่โรงพยาบาลอีกครั้ง';
  const NOT_CERT = 'ระบบนี้เป็นเพียงระบบจองคิวและคัดกรองเบื้องต้น ไม่ใช่การรับรองสิทธิ์บริจาคเลือด';
  const app = document.getElementById('app');

  const QUESTIONS = [
    { k: 'age_ok',     t: 'อายุอยู่ระหว่าง 18-60 ปี หรือไม่', good: true },
    { k: 'weight_ok',  t: 'น้ำหนักไม่ต่ำกว่า 45 กก. หรือไม่', good: true },
    { k: 'donated_3m', t: 'ใน 3 เดือนล่าสุด คุณเคยบริจาคเลือดหรือไม่', good: false },
    { k: 'sick_7d',    t: 'ใน 7 วันล่าสุด คุณมีไข้ หวัด หรืออาการป่วยหรือไม่', good: false },
    { k: 'surgery_6m', t: 'ใน 6 เดือนล่าสุด คุณเคยผ่าตัดหรือได้รับการถ่ายเลือดหรือไม่', good: false },
    { k: 'chronic',    t: 'คุณมีโรคประจำตัวที่ห้ามบริจาค เช่น โรคหัวใจ ความดันสูงที่ควบคุมไม่ได้ เบาหวาน หรือไม่', good: false },
  ];

  const state = { me: null, slots: [], selDate: null, selSlot: null, friend: true };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d, o) => new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', { timeZone: 'UTC', ...o });
  const longDate = (d) => fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const STATUS = { pending: ['รอยืนยัน', 'warn'], completed: ['บริจาคสำเร็จ', 'ok'], cancelled: ['ยกเลิก', 'bad'], no_show: ['ไม่มา', 'bad'] };
  const render = (html) => { app.innerHTML = html; window.scrollTo(0, 0); };
  const loading = (t = 'กำลังโหลด...') => render(`<div class="center">${esc(t)}</div>`);
  const todayBkk = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  // แสดงข้อผิดพลาด (ถ้ามีรายละเอียดทางเทคนิคจากเซิร์ฟเวอร์ จะแสดงตัวเล็กสีเทา ช่วยให้ถ่ายภาพส่งมาวินิจฉัยได้)
  const errHtml = (e) => `<div class="err">${esc(e.message || e)}${e.detail ? `<br><small style="opacity:.7">รายละเอียด: ${esc(e.detail)}</small>` : ''}</div>`;
  const showErr = (m) => { const e = document.getElementById('err'); if (e) e.innerHTML = typeof m === 'string' ? `<div class="err">${esc(m)}</div>` : errHtml(m); };
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };

  async function api(action, payload = {}) {
    const res = await fetch(`${C.FUNCTIONS_URL}/donor-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-line-id-token': liff.getIDToken() },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    // LINE ID Token หมดอายุ (อายุประมาณ 1 ชม.) -> ล็อกอินใหม่อัตโนมัติ
    if (res.status === 401) { liff.logout(); location.reload(); throw new Error('เซสชันหมดอายุ กำลังเข้าสู่ระบบใหม่...'); }
    if (!res.ok) throw Object.assign(new Error(data.message || 'เกิดข้อผิดพลาด'), { code: data.error, detail: data.detail });
    return data;
  }

  // ---------- boot ----------
  async function boot() {
    try {
      await liff.init({ liffId: C.LIFF_ID });
      if (!liff.isLoggedIn()) { liff.login(); return; }
      try { state.friend = (await liff.getFriendship()).friendFlag; } catch { state.friend = true; }
      await refreshMe();
      !state.me.consented ? consent() : !state.me.profile_complete ? profileForm(true) : home();
    } catch (e) {
      render(`<div class="card"><h2>เปิดระบบไม่สำเร็จ</h2>${errHtml(e)}<button onclick="location.reload()">ลองใหม่</button></div>`);
    }
  }
  async function refreshMe() { state.me = await api('me'); }

  // ---------- 1) ข้อมูลส่วนตัว + ยินยอม PDPA ----------
  // กรอกครั้งเดียว: ชื่อ-นามสกุล, เลขบัตรประชาชน (ตรวจเลขให้ทันที), วันเกิด (เลือก วัน/เดือน/ปี พ.ศ. คำนวณอายุให้), เพศ, เบอร์โทร
  const MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const cidValid = (c) => { if (!/^\d{13}$/.test(c)) return false; let t = 0; for (let i = 0; i < 12; i++) t += Number(c[i]) * (13 - i); return (11 - (t % 11)) % 10 === Number(c[12]); };
  const cidFormat = (d) => [d.slice(0, 1), d.slice(1, 5), d.slice(5, 10), d.slice(10, 12), d.slice(12, 13)].filter(Boolean).join('-');
  const ageFrom = (iso, on) => { const [by, bm, bd] = iso.split('-').map(Number), [oy, om, od] = on.split('-').map(Number); return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0); };

  function consent() { profileForm(false); }

  function profileForm(existing) {
    const me = state.me || {};
    const [first, ...rest] = String(me.full_name || '').split(' ');
    const by0 = new Date().getUTCFullYear() + 543, bd = me.birth_date ? me.birth_date.split('-').map(Number) : [0, 0, 0];
    const opts = (arr, sel, ph) => `<option value="">${ph}</option>` + arr.map(([v, t]) => `<option value="${v}" ${String(v) === String(sel) ? 'selected' : ''}>${t}</option>`).join('');
    const days = Array.from({ length: 31 }, (_, i) => [i + 1, i + 1]);
    const months = MONTHS.map((m, i) => [i + 1, m]);
    const years = Array.from({ length: 80 }, (_, i) => [by0 - 15 - i - 543, by0 - 15 - i]);   // value = ค.ศ., แสดง = พ.ศ. (อายุ 15-94 ปี)
    render(`
      <div class="card">
        <h2>${existing ? 'กรุณากรอกข้อมูลเพิ่มเติม' : 'ข้อมูลผู้บริจาค'}</h2>
        <p class="mute">${existing ? 'ระบบเพิ่มการเก็บเลขบัตรประชาชนและวันเกิด เพื่อยืนยันตัวตน คำนวณอายุ และเตรียมบันทึกประวัติผู้บริจาค — กรอกครั้งเดียว ครั้งต่อไปไม่ต้องกรอกอีก' : 'กรอกครั้งเดียว ครั้งต่อไปไม่ต้องกรอกอีก ใช้เวลาประมาณ 1 นาที'}</p>
        <label for="fn">ชื่อ</label><input id="fn" type="text" autocomplete="given-name" value="${esc(first || '')}">
        <label for="ln">นามสกุล</label><input id="ln" type="text" autocomplete="family-name" value="${esc(rest.join(' '))}">
        <label for="cid">เลขบัตรประชาชน 13 หลัก</label>
        <input id="cid" type="text" inputmode="numeric" autocomplete="off" maxlength="17" placeholder="เช่น 1-2345-67890-12-3">
        <div id="cidh" class="mute"></div>
        <label>วันเกิด</label>
        <div class="dob">
          <select id="bd" aria-label="วัน">${opts(days, bd[2], 'วัน')}</select>
          <select id="bm" aria-label="เดือน">${opts(months, bd[1], 'เดือน')}</select>
          <select id="by" aria-label="ปี พ.ศ.">${opts(years, bd[0], 'ปี พ.ศ.')}</select></div>
        <div id="ageh" class="mute"></div>
        <label>เพศ</label>
        <div class="opts" style="margin-top:0">
          <label><input type="radio" name="g" value="male" ${me.gender === 'male' ? 'checked' : ''}><span>ชาย</span></label>
          <label><input type="radio" name="g" value="female" ${me.gender === 'female' ? 'checked' : ''}><span>หญิง</span></label>
          <label><input type="radio" name="g" value="other" ${me.gender === 'other' ? 'checked' : ''}><span>ไม่ระบุ</span></label></div>
        <label for="ph">เบอร์โทร (ไม่บังคับ)</label><input id="ph" type="tel" inputmode="tel" autocomplete="tel" value="${esc(me.phone || '')}">
        <div class="disclaimer" style="margin-top:14px"><b>นโยบายความเป็นส่วนตัว (PDPA)</b><br>
          โรงพยาบาลอ่างทองเก็บ ชื่อ-นามสกุล เลขบัตรประชาชน วันเกิด เพศ เบอร์โทร LINE User ID ข้อมูลการจองคิว ผลคัดกรองเพียง "ผ่าน/ไม่ผ่าน" และประวัติการบริจาค
          เพื่อ ยืนยันตัวตน จองคิว แจ้งเตือน ออกใบเกียรติบัตร และบันทึกประวัติผู้บริจาคของธนาคารเลือดเท่านั้น
          เลขบัตรประชาชนเข้าถึงได้เฉพาะผู้ดูแลระบบที่ได้รับมอบหมาย ระบบ<b>ไม่เก็บ</b>คำตอบด้านสุขภาพรายข้อ
          คุณถอนความยินยอมและลบข้อมูลได้ทุกเมื่อที่เมนู "ข้อมูลส่วนตัว"</div>
        <div class="disclaimer">${NOT_CERT}<br>${DISCLAIMER}</div>
        <label style="display:flex;gap:8px;align-items:flex-start;font-weight:500"><input id="ok" type="checkbox" style="margin-top:5px">
          <span>ข้าพเจ้าได้อ่านและยินยอมให้เก็บ ใช้ ข้อมูลตามนโยบายนี้</span></label>
        <div id="err"></div>
        <button id="go">${existing ? 'บันทึกข้อมูล' : 'ยินยอมและเริ่มใช้งาน'}</button>
        ${existing ? '<button id="back" class="link">กลับ</button>' : ''}
      </div>`);
    const $ = (id) => document.getElementById(id);
    const dobISO = () => {
      const y = $('by').value, m = $('bm').value, d = $('bd').value; if (!y || !m || !d) return null;
      const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return new Date(iso + 'T00:00:00Z').toISOString().slice(0, 10) === iso ? iso : '';      // '' = วันที่ไม่มีจริง เช่น 31 ก.พ.
    };
    const updAge = () => {
      const iso = dobISO(), h = $('ageh');
      if (iso === null) { h.textContent = ''; return; }
      if (iso === '') { h.innerHTML = '<span style="color:#c62828">วันที่ไม่ถูกต้อง</span>'; return; }
      const a = ageFrom(iso, todayBkk());
      h.innerHTML = a >= 18 && a <= 60 ? `อายุ ${a} ปี ✓` : `<span style="color:#b26a00">อายุ ${a} ปี — ผู้บริจาคต้องอายุ 18-60 ปี (บันทึกข้อมูลได้ แต่จะจองคิวไม่ได้)</span>`;
    };
    ['bd', 'bm', 'by'].forEach((id) => $(id).addEventListener('change', updAge)); updAge();
    $('cid').addEventListener('input', () => {
      const d = $('cid').value.replace(/\D/g, '').slice(0, 13); $('cid').value = cidFormat(d);
      $('cidh').innerHTML = d.length < 13 ? `พิมพ์แล้ว ${d.length}/13 หลัก` : cidValid(d) ? '✓ เลขบัตรถูกต้อง' : '<span style="color:#c62828">เลขบัตรไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง</span>';
    });
    on('back', home);
    on('go', async () => {
      const fn = $('fn').value.trim(), ln = $('ln').value.trim(), cid = $('cid').value.replace(/\D/g, '');
      const iso = dobISO(), gender = document.querySelector('input[name=g]:checked')?.value;
      if (!fn || !ln) return showErr('กรุณากรอกชื่อและนามสกุล');
      if (!cidValid(cid)) return showErr('เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจสอบเลข 13 หลักอีกครั้ง');
      if (!iso) return showErr('กรุณาเลือกวันเกิดให้ครบและถูกต้อง');
      if (!gender) return showErr('กรุณาเลือกเพศ');
      if (!$('ok').checked) return showErr('กรุณาติ๊กยินยอมก่อนบันทึก');
      try {
        await api(existing ? 'profile' : 'consent', { full_name: `${fn} ${ln}`, phone: $('ph').value.trim(), cid, birth_date: iso, gender, accept: true });
        await refreshMe(); home();
      } catch (e) { showErr(e.message); }
    });
  }

  // ---------- หน้าแรก ----------
  function home() {
    const b = state.me.active_booking;
    render(`
      ${state.friend ? '' : `<div class="banner">เพิ่มเพื่อน LINE OA ของธนาคารเลือดก่อน เพื่อรับข้อความเตือนนัด
        <a href="https://line.me/R/ti/p/${encodeURIComponent(C.OA_BASIC_ID)}">เพิ่มเพื่อน</a></div>`}
      <div class="card">
        <h2>สวัสดี ${esc(state.me.full_name || '')}</h2>
        ${b ? `
          <p>คิวของคุณ <span class="tag warn">รอยืนยัน</span></p>
          <p><b>${esc(longDate(b.booking_date))}</b><br>เวลา ${esc(b.time_slots?.label)} น.</p>
          <p class="mute">กรุณาตรวจสุขภาพตัวเองอีกครั้งก่อนมา และหากไม่สบายให้ยกเลิกคิว</p>
          <button id="cancel" class="secondary">ยกเลิกคิวนี้</button>
        ` : `<p class="mute">คุณยังไม่มีคิวที่รออยู่</p>
          <button id="book">จองคิวบริจาคเลือด</button>`}
        <div id="err"></div>
      </div>
      <div class="card">
        <button id="hist" class="secondary" style="margin-top:0">ประวัติการจอง/บริจาค</button>
        <button id="editp" class="link">แก้ไขข้อมูลส่วนตัว</button>
        <button id="priv" class="link">ข้อมูลส่วนตัว / ลบข้อมูล</button>
      </div>
      <div class="disclaimer">${NOT_CERT}</div>`);
    on('book', () => (!state.me.profile_complete ? profileForm(true) : state.me.screening_valid ? slots() : screening()));
    on('hist', history);
    on('priv', privacy);
    on('editp', () => profileForm(true));
    on('cancel', async () => {
      if (!confirm('ยืนยันยกเลิกคิวนี้?')) return;
      try { await api('cancel', { booking_id: b.id }); await refreshMe(); home(); } catch (e) { showErr(e.message); }
    });
  }

  // ---------- 2) คัดกรอง ----------
  function screening() {
    // มีวันเกิด/เพศในระบบแล้ว: ไม่ถามอายุและเพศซ้ำ (เซิร์ฟเวอร์คำนวณเอง)
    const knownGender = state.me.gender, knownAge = state.me.age != null;
    const QS = QUESTIONS.filter((q) => !(knownAge && q.k === 'age_ok'));
    const yn = (k) => `<div class="opts">
        <label><input type="radio" name="${k}" value="yes"><span>ใช่</span></label>
        <label><input type="radio" name="${k}" value="no"><span>ไม่ใช่</span></label></div>`;
    render(`
      <div class="card">
        <h2>แบบคัดกรองเบื้องต้น</h2>
        <div class="disclaimer">${DISCLAIMER}</div>
        ${knownGender ? '' : `<div class="q"><b>เพศ</b><div class="opts">
          <label><input type="radio" name="gender" value="female"><span>หญิง</span></label>
          <label><input type="radio" name="gender" value="male"><span>ชาย</span></label>
          <label><input type="radio" name="gender" value="other"><span>ไม่ระบุ</span></label></div></div>`}
        ${QS.map((q, i) => `<div class="q"><b>${i + 1}. ${esc(q.t)}</b>${yn(q.k)}</div>`).join('')}
        <div class="q" id="fq" style="display:none"><b>สำหรับผู้หญิง: ขณะนี้อยู่ในระยะมีประจำเดือน หรือคลอดบุตรภายใน 6 เดือน หรือไม่</b>${yn('female_condition')}</div>
        <div id="err"></div>
        <button id="submit">ส่งแบบคัดกรอง</button>
        <button id="back" class="link">กลับ</button>
      </div>`);
    document.querySelectorAll('input[name=gender]').forEach((r) =>
      r.addEventListener('change', () => { document.getElementById('fq').style.display = r.value === 'female' ? 'block' : 'none'; }));
    if (knownGender === 'female') document.getElementById('fq').style.display = 'block';
    on('back', home);
    on('submit', async () => {
      const val = (n) => document.querySelector(`input[name=${n}]:checked`)?.value;
      const gender = knownGender || val('gender');
      const answers = { gender };
      for (const q of QS) {
        const v = val(q.k); if (!v) return showErr('กรุณาตอบให้ครบทุกข้อ');
        answers[q.k] = v === 'yes';
      }
      if (!gender) return showErr('กรุณาเลือกเพศ');
      if (gender === 'female') { const v = val('female_condition'); if (!v) return showErr('กรุณาตอบให้ครบทุกข้อ'); answers.female_condition = v === 'yes'; }
      try { screenResult(await api('screen', { answers })); } catch (e) { showErr(e.message); }
    });
  }

  function screenResult(r) {
    render(`
      <div class="card">
        <h2>${r.passed ? '✅ ผ่านการคัดกรองเบื้องต้น' : 'ยังไม่ผ่านการคัดกรองเบื้องต้น'}</h2>
        ${r.passed
          ? '<p>คุณสามารถเลือกวันและเวลาจองคิวได้ (ผลมีผล 7 วัน)</p>'
          : `<p>เหตุผล:</p><ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
             <p class="mute">ขณะนี้ยังไม่เปิดให้จองคิว หากสถานการณ์เปลี่ยนสามารถทำแบบคัดกรองใหม่ได้ หรือสอบถามเจ้าหน้าที่ธนาคารเลือด</p>`}
        <div class="disclaimer">${esc(r.disclaimer)}</div>
        ${r.passed ? '<button id="next">เลือกวันและเวลา</button>' : '<button id="again" class="secondary">ทำแบบคัดกรองใหม่</button>'}
        <button id="home" class="link">กลับหน้าแรก</button>
      </div>`);
    on('next', async () => { await refreshMe(); slots(); });
    on('again', screening);
    on('home', async () => { await refreshMe(); home(); });
  }

  // ---------- 3) เลือกคิว: ปฏิทินรายเดือน ----------
  // จุดเขียว = ว่างให้จอง · จุดแดง = เต็ม · จุดส้ม/พื้นส้ม = วันหยุด · เทา = ปิดรับ (รวมเสาร์-อาทิตย์ที่ไม่เปิด)
  const DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const monthLabel = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('th-TH', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const shiftMonth = (ym, n) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

  async function slots() {
    loading('กำลังโหลดปฏิทินคิว...');
    try {
      const c = await api('calendar');
      state.slots = c.slots; state.today = c.today; state.maxDate = c.to;
      state.holidays = Object.fromEntries(c.holidays.map((h) => [h.holiday_date, h.name]));
    } catch (e) { render(`<div class="card">${errHtml(e)}<button id="b">กลับ</button></div>`); return on('b', home); }
    state.selDate = state.selSlot = null;
    state.month = state.today.slice(0, 7);
    drawSlots();
  }

  // สถานะของแต่ละวัน
  function dayInfo(d) {
    if (d < state.today || d > state.maxDate) return { s: 'out' };
    if (state.holidays[d]) return { s: 'holiday', name: state.holidays[d] };
    // เสาร์-อาทิตย์เปิดรับได้ถ้าเจ้าหน้าที่ตั้งจำนวนไว้ (เซิร์ฟเวอร์ส่งมาเฉพาะวัน/ช่วงที่เปิด) จึงดูจากรายการช่วงเวลาอย่างเดียว
    const list = state.slots.filter((x) => x.slot_date === d);
    if (!list.length) return { s: 'none' };                      // ไม่เปิดรับ (เช่น เสาร์-อาทิตย์ที่ปิด) หรือช่วงเวลาผ่านไปหมดแล้ว
    return list.some((x) => x.available > 0) ? { s: 'open' } : { s: 'full' };
  }

  function drawSlots() {
    const ym = state.month, [Y, M] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(Y, M - 1, 1)).getUTCDay();
    const daysIn = new Date(Date.UTC(Y, M, 0)).getUTCDate();
    const minM = state.today.slice(0, 7), maxM = state.maxDate.slice(0, 7);

    let cells = DOW.map((x, i) => `<div class="cal-dow ${i === 0 || i === 6 ? 'we' : ''}">${x}</div>`).join('');
    cells += '<div></div>'.repeat(first);
    for (let n = 1; n <= daysIn; n++) {
      const d = `${ym}-${String(n).padStart(2, '0')}`, info = dayInfo(d);
      const clickable = ['open', 'full', 'holiday'].includes(info.s);
      const dot = info.s === 'open' ? 'g' : info.s === 'full' ? 'r' : info.s === 'holiday' ? 'o' : '';
      cells += `<button class="cd s-${info.s} ${d === state.today ? 'today' : ''} ${d === state.selDate ? 'sel' : ''}" data-d="${d}" ${clickable ? '' : 'disabled'}
        aria-label="${esc(longDate(d))}${info.s === 'open' ? ' ว่าง' : info.s === 'full' ? ' เต็ม' : info.s === 'holiday' ? ' วันหยุด ' + esc(info.name) : ''}">
        <span class="n">${n}</span>${dot ? `<i class="dot ${dot}"></i>` : ''}</button>`;
    }

    // รายชื่อวันหยุดของเดือนที่กำลังดู
    const monthHolidays = Object.entries(state.holidays).filter(([d]) => d.startsWith(ym));
    // ส่วนรายละเอียดของวันที่เลือก
    let panel = '<p class="mute" style="text-align:center">แตะวันที่มี <b style="color:#2e9e4f">จุดสีเขียว</b> เพื่อเลือกช่วงเวลา</p>';
    if (state.selDate) {
      const info = dayInfo(state.selDate), day = state.slots.filter((s) => s.slot_date === state.selDate);
      if (info.s === 'holiday') panel = `<div class="holbox">🟠 <b>${esc(longDate(state.selDate))}</b><br>วันหยุด: ${esc(info.name)} — ไม่เปิดรับบริจาค</div>`;
      else if (info.s === 'full') panel = `<div class="fullbox"><b>${esc(longDate(state.selDate))}</b><br>คิวเต็มทุกช่วงเวลาแล้ว กรุณาเลือกวันอื่น</div>`;
      else panel = `<p><b>${esc(longDate(state.selDate))}</b></p>` + ['morning', 'afternoon'].map((p) => {
        const list = day.filter((s) => s.period === p);
        return list.length ? `<p class="mute" style="margin:8px 0 0"><b>${p === 'morning' ? 'ช่วงเช้า' : 'ช่วงบ่าย'}</b></p>` + list.map((s) => `
          <button class="slot ${state.selSlot === s.slot_id ? 'sel' : ''}" data-s="${s.slot_id}" ${s.available < 1 ? 'disabled' : ''}>
            <span>${esc(s.label)} น.</span>
            <span class="tag ${s.available < 1 ? 'bad' : 'ok'}">${s.available < 1 ? 'เต็ม' : `ว่าง ${s.available}`}</span></button>`).join('') : '';
      }).join('');
    }

    render(`
      <div class="card">
        <h2>เลือกวันและเวลา</h2>
        <div class="cal-head">
          <button class="cal-nav" id="pm" ${ym <= minM ? 'disabled' : ''} aria-label="เดือนก่อน">‹</button>
          <b>${esc(monthLabel(ym))}</b>
          <button class="cal-nav" id="nm" ${ym >= maxM ? 'disabled' : ''} aria-label="เดือนถัดไป">›</button>
        </div>
        <div class="cal-grid">${cells}</div>
        <div class="legend"><span><i class="dot g"></i>ว่างให้จอง</span><span><i class="dot r"></i>เต็ม</span><span><i class="dot o"></i>วันหยุด</span><span><i class="dot x"></i>ปิดรับ/ผ่านแล้ว</span></div>
        ${monthHolidays.length ? `<div class="holnote">วันหยุดเดือนนี้: ${monthHolidays.map(([d, n]) => `${esc(fmtDate(d, { day: 'numeric' }))} ${esc(n)}`).join(' · ')}</div>` : ''}
        <div class="slotpanel">${panel}</div>
        <div id="err"></div>
        <button id="confirm" ${state.selSlot ? '' : 'disabled'}>ถัดไป: ยืนยันการจอง</button>
        <button id="back" class="link">กลับ</button>
      </div>`);
    on('pm', () => { state.month = shiftMonth(ym, -1); drawSlots(); });
    on('nm', () => { state.month = shiftMonth(ym, 1); drawSlots(); });
    document.querySelectorAll('.cd:not([disabled])').forEach((b) => b.addEventListener('click', () => { state.selDate = b.dataset.d; state.selSlot = null; drawSlots(); }));
    document.querySelectorAll('.slot').forEach((b) => b.addEventListener('click', () => { state.selSlot = Number(b.dataset.s); drawSlots(); }));
    on('back', home);
    on('confirm', confirmBooking);
  }

  // ---------- 4) ยืนยัน ----------
  function confirmBooking() {
    const s = state.slots.find((x) => x.slot_date === state.selDate && x.slot_id === state.selSlot);
    render(`
      <div class="card">
        <h2>ยืนยันการจอง</h2>
        <p><b>${esc(longDate(s.slot_date))}</b><br>เวลา ${esc(s.label)} น.<br>ธนาคารเลือด โรงพยาบาลอ่างทอง</p>
        <div class="disclaimer">${DISCLAIMER}<br>${NOT_CERT}</div>
        <div id="err"></div>
        <button id="ok">ยืนยันจองคิว</button>
        <button id="back" class="link">แก้ไขวัน/เวลา</button>
      </div>`);
    on('back', drawSlots);
    on('ok', async () => {
      const btn = document.getElementById('ok'); btn.disabled = true;
      try {
        await api('book', { slot_id: s.slot_id, date: s.slot_date });
        render(`<div class="card"><h2>✅ จองคิวสำเร็จ</h2>
          <p>${esc(longDate(s.slot_date))}<br>เวลา ${esc(s.label)} น.</p>
          <p class="mute">ระบบส่งข้อความยืนยันทาง LINE แล้ว และจะเตือนล่วงหน้า 1 วัน</p>
          <button id="home">กลับหน้าแรก</button></div>`);
        on('home', async () => { await refreshMe(); home(); });
      } catch (e) {
        btn.disabled = false; showErr(e.message);
        if (e.code === 'SLOT_FULL') { setTimeout(slots, 1500); }
      }
    });
  }

  // ---------- ประวัติ ----------
  async function history() {
    loading();
    try {
      const h = await api('history');
      render(`
        <div class="card"><h2>ประวัติการบริจาค</h2>
          ${h.donations.length ? h.donations.map((d) => `<p>🩸 ${esc(longDate(d.donated_on))}<br><span class="mute">เลขที่ ${esc(d.certificate_no)}</span>
              <button class="secondary" data-cert="${esc(d.certificate_no)}" style="margin-top:6px;padding:9px;font-size:14px">ดูใบเกียรติบัตร / บันทึก PDF</button></p>`).join('')
            : '<p class="mute">ยังไม่มีประวัติการบริจาค</p>'}
          <p class="mute">จำนวนครั้งที่บริจาค: ${h.donations.length}</p></div>
        <div class="card"><h2>ประวัติการจอง</h2>
          ${h.bookings.length ? h.bookings.map((b) => {
              const [t, c] = STATUS[b.status] || [b.status, ''];
              const canCancel = b.status === 'pending' && b.booking_date >= todayBkk();
              return `<p>${esc(fmtDate(b.booking_date, { day: 'numeric', month: 'short', year: 'numeric' }))} ${esc(b.time_slots?.label)} น. <span class="tag ${c}">${t}</span>
                ${canCancel ? `<br><button class="secondary" data-cancel="${esc(b.id)}" style="margin-top:6px;padding:9px;font-size:14px">ยกเลิกคิวนี้</button>` : ''}</p>`;
            }).join('')
            : '<p class="mute">ยังไม่มีการจอง</p>'}
          <div id="err"></div></div>
        <button id="home" class="secondary">กลับหน้าแรก</button>`);
      on('home', async () => { await refreshMe(); home(); });
      document.querySelectorAll('[data-cancel]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('ยืนยันยกเลิกคิวนี้?')) return;
        try { await api('cancel', { booking_id: btn.dataset.cancel }); await refreshMe(); history(); } catch (e) { showErr(e); }
      }));
      document.querySelectorAll('[data-cert]').forEach((b) => b.addEventListener('click', () => certificate(b.dataset.cert)));
    } catch (e) { render(`<div class="card">${errHtml(e)}<button id="home">กลับ</button></div>`); on('home', home); }
  }

  // ---------- ใบเกียรติบัตร PDF ----------
  // วาดด้วย canvas (ฟอนต์ Sarabun จัดสระ/วรรณยุกต์ไทยถูกต้อง) แล้วฝังลง PDF ด้วย jsPDF
  async function certificate(no) {
    loading('กำลังสร้างใบเกียรติบัตร...');
    try {
      const d = await api('certificate', { certificate_no: no });
      await Promise.all([document.fonts.load('700 64px Sarabun'), document.fonts.load('400 34px Sarabun')]);
      const cv = drawCertificate(d);
      const img = cv.toDataURL('image/jpeg', 0.92);
      render(`
        <div class="card"><h2>ใบเกียรติบัตร</h2>
          <img src="${img}" alt="ใบเกียรติบัตรการบริจาคโลหิต" style="width:100%;border:1px solid var(--line);border-radius:8px">
          <button id="pdf">บันทึกเป็น PDF</button>
          <p class="mute">หากกดบันทึก PDF ในแอป LINE ไม่ได้ ให้กดค้างที่รูปเพื่อบันทึกเป็นภาพแทน</p>
          <button id="back" class="link">กลับ</button></div>`);
      on('back', history);
      on('pdf', () => {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        pdf.addImage(img, 'JPEG', 0, 0, 297, 210);
        pdf.save(`certificate-${d.certificate_no}.pdf`);
      });
    } catch (e) { render(`<div class="card"><div class="err">${esc(e.message)}</div><button id="back">กลับ</button></div>`); on('back', history); }
  }

  function drawCertificate(d) {
    const W = 1754, H = 1240;                       // A4 แนวนอน ~150 dpi
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#fffdfb'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#c62828'; g.lineWidth = 14; g.strokeRect(50, 50, W - 100, H - 100);
    g.lineWidth = 3; g.strokeRect(78, 78, W - 156, H - 156);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const t = (txt, y, size, weight, color) => { g.font = `${weight} ${size}px Sarabun, sans-serif`; g.fillStyle = color; g.fillText(txt, W / 2, y); };
    g.fillStyle = '#c62828'; g.font = '110px sans-serif'; g.fillText('🩸', W / 2, 270);
    t('ใบเกียรติบัตร', 390, 96, 700, '#8e1b1b');
    t('ธนาคารเลือด โรงพยาบาลอ่างทอง', 470, 42, 400, '#444');
    t('ขอมอบให้ไว้เพื่อแสดงว่า', 590, 40, 400, '#444');
    let size = 88; g.font = `700 ${size}px Sarabun`;
    while (g.measureText(d.full_name).width > W - 360 && size > 40) { size -= 4; g.font = `700 ${size}px Sarabun`; }
    t(d.full_name, 710, size, 700, '#222');
    g.strokeStyle = '#c62828'; g.lineWidth = 2; g.beginPath(); g.moveTo(330, 740); g.lineTo(W - 330, 740); g.stroke();
    t('ได้บริจาคโลหิตเพื่อช่วยชีวิตผู้ป่วย ณ ธนาคารเลือด โรงพยาบาลอ่างทอง', 830, 40, 400, '#333');
    t('เมื่อวันที่ ' + fmtDate(d.donated_on, { day: 'numeric', month: 'long', year: 'numeric' }), 905, 40, 400, '#333');
    t('ขอขอบคุณในน้ำใจอันประเสริฐของท่าน', 1010, 44, 700, '#c62828');
    t('เลขที่ ' + d.certificate_no, 1120, 28, 400, '#777');
    return cv;
  }

  // ---------- ข้อมูลส่วนตัว / ลบข้อมูล ----------
  function privacy() {
    render(`
      <div class="card">
        <h2>ข้อมูลส่วนตัว</h2>
        <p>คุณสามารถถอนความยินยอมและขอลบข้อมูลส่วนบุคคลได้ ระบบจะยกเลิกคิวที่รออยู่ ลบผลคัดกรอง และลบชื่อ เลขบัตรประชาชน วันเกิด เบอร์โทรออกจากระบบ
        (ประวัติการบริจาคจะคงไว้โดยไม่ระบุตัวตนตามข้อกำหนดการเก็บเวชระเบียน)</p>
        <div id="err"></div>
        <button id="erase">ถอนความยินยอมและลบข้อมูลของฉัน</button>
        <button id="back" class="link">กลับ</button>
      </div>`);
    on('back', home);
    on('erase', async () => {
      if (!confirm('ยืนยันลบข้อมูลและถอนความยินยอม? การกระทำนี้ย้อนกลับไม่ได้')) return;
      try {
        await api('erase');
        render('<div class="card"><h2>ลบข้อมูลเรียบร้อย</h2><p class="mute">หากต้องการใช้งานอีกครั้ง ให้เปิดระบบใหม่และยินยอมนโยบายอีกครั้ง</p></div>');
        setTimeout(() => liff.closeWindow(), 2500);
      } catch (e) { showErr(e.message); }
    });
  }

  boot();
})();
