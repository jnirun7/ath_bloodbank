// ค่าตั้งต้นของหน้า LIFF และแดชบอร์ด (ไม่มีความลับ จึงวางบน GitHub Pages สาธารณะได้)
// ห้ามใส่ service_role key / Channel access token / Secret key ในไฟล์นี้เด็ดขาด
window.CONFIG = {
  LIFF_ID: 'xxxxxxxxxx-xxxxxxxx',                          // จาก LINE Developers > LIFF
  SUPABASE_URL: 'https://<PROJECT_REF>.supabase.co',
  FUNCTIONS_URL: 'https://<PROJECT_REF>.supabase.co/functions/v1',
  // anon / publishable key (Dashboard > Settings > API Keys) - ออกแบบมาให้เปิดเผยได้ ข้อมูลถูกป้องกันด้วย RLS
  // ใช้เฉพาะแดชบอร์ดเจ้าหน้าที่ (admin.html)
  SUPABASE_ANON_KEY: '<ANON_OR_PUBLISHABLE_KEY>',
  OA_BASIC_ID: '@xxxxxxxx',                                // LINE OA Basic ID (ใช้ลิงก์เพิ่มเพื่อน)
};
