// ค่าตั้งต้นของหน้า LIFF และแดชบอร์ด (ไม่มีความลับ จึงวางบน GitHub Pages สาธารณะได้)
// ห้ามใส่ service_role key / Channel access token / Secret key ในไฟล์นี้เด็ดขาด
window.CONFIG = {
  LIFF_ID: '2012527771-AXPzrbDR',                          // จาก LINE Developers > LIFF
  SUPABASE_URL: 'https://ofdtvnbmbkeliwscflno.supabase.co',
  FUNCTIONS_URL: 'https://ofdtvnbmbkeliwscflno.supabase.co/functions/v1',
  // anon / publishable key (Dashboard > Settings > API Keys) - ออกแบบมาให้เปิดเผยได้ ข้อมูลถูกป้องกันด้วย RLS
  // ใช้เฉพาะแดชบอร์ดเจ้าหน้าที่ (admin.html)
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mZHR2bmJtYmtlbGl3c2NmbG5vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyODg1MzgsImV4cCI6MjEwOTg2NDUzOH0.dpJOvrxaAzqHnAKcp55xbXhvcR-0nldHkUP9gh9Bqms',
  OA_BASIC_ID: '@290ghvhq',                                // LINE OA Basic ID (ใช้ลิงก์เพิ่มเพื่อน)
};
