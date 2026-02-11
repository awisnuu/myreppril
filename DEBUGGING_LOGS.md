# 🐛 Debugging Guide - Railway Worker

## Masalah yang Ditemukan

### 1️⃣ **Log Scheduler Tidak Muncul**

**Penyebab:**
- Kondisi logging `now.getSeconds() < 60` tidak efektif
- Interval check 60 detik tidak sinkron dengan menit yang tepat
- Tidak ada konfirmasi bahwa fungsi `checkScheduledWatering()` berjalan

**Solusi:**
✅ Tambah counter untuk track setiap check
✅ Log setiap kali fungsi dipanggil: `⏱️ CHECK #X`
✅ Log detail setiap 3 check atau setiap 5 menit
✅ Jalankan check pertama kali setelah 5 detik (tidak tunggu 60 detik)

---

### 2️⃣ **Aktuator Tidak Trigger**

**Kemungkinan Penyebab:**
- Node `/aktuator` tidak ada di Firebase
- Format waktu tidak match dengan jadwal
- Queue tidak menjalankan job
- Firebase update gagal tanpa error log

**Solusi:**
✅ Validasi node aktuator saat startup
✅ Log verbose untuk setiap Firebase update
✅ Verify state aktuator setelah update
✅ Log queue status (active/waiting jobs)

---

## 📊 Log Baru yang Akan Muncul

### Saat Startup (5 detik pertama):
```
🔧 RUNNING DIAGNOSTIC CHECKS...
🕐 CURRENT TIME ANALYSIS:
   Server Local: Wed Feb 11 2026 10:20:05 GMT+0700
   Asia/Jakarta: 11/2/2026, 10.20.05
   TZ Env: Asia/Jakarta
   HH:MM Format: 10:20

📋 FIREBASE KONTROL:
   Mode Waktu: ENABLED ✅
   Waktu 1: 10:18
   Waktu 2: 09:00

🔍 CHECKING AKTUATOR NODE...
✅ Aktuator node exists:
   mosvet_1: false
   mosvet_2: false
   ...

🚀 Running first schedule check immediately...
```

### Setiap 60 Detik:
```
⏱️ CHECK #1: 10:20:15 | Mode: ✅
⏱️ CHECK #2: 10:21:15 | Mode: ✅
⏱️ CHECK #3: 10:22:15 | Mode: ✅
   📅 Date: 2026-02-11
   🕐 Current: 10:22 (11/2/2026, 10.22.15)
   Mode Waktu: ✅ ENABLED
   Jadwal 1: 10:18
   Jadwal 2: 09:00
```

### Saat Jadwal Match:
```
⏱️ CHECK #8: 10:25:00 | Mode: ✅
   📅 Date: 2026-02-11
   🕐 Current: 10:25 (11/2/2026, 10.25.00)
   Mode Waktu: ✅ ENABLED
   Jadwal 1: 10:25 🔔 MATCH!
   Jadwal 2: 09:00

🕐 JADWAL 1 TRIGGERED: 10:25
   🎯 Attempting to add job to queue...
   ✅ Successfully added to queue: jadwal_1_2026-02-11_10:25
   📊 Queue status: 1 active, 0 waiting

💧 Processing Job: jadwal_1_2026-02-11_10:25
   Type: waktu_jadwal_1
   Pots: [1, 2, 3, 4, 5]
   Duration: 300s
   🔛 Turning ON: mosvet_1, mosvet_2, mosvet_3, mosvet_4, mosvet_5, mosvet_6, mosvet_7
   📌 Firebase path: aktuator
   📝 Updates: {
     "mosvet_1": true,
     "mosvet_2": true,
     ...
   }
   ✅ Firebase update successful
   🔍 Verified aktuator state: { ... }
   ⏳ 300s remaining...
   ⏳ 290s remaining...
   ...
```

### Saat Sensor Trigger:
```
🌡️ SENSOR CHECK #10 | Mode Otomatis: ✅

🌡️ SENSOR TRIGGERED: POT 1
   Soil moisture: 35% < 40%
   Mode: smart, Duration: 600s
   📌 Added to queue: sensor-pot-1-...
```

---

## 🔧 Cara Testing

### Test 1: Verifikasi Worker Berjalan
1. Check Railway logs untuk `CHECK #X` setiap menit
2. Pastikan counter naik: `CHECK #1, #2, #3...`
3. Jika tidak ada, worker crash atau interval tidak jalan

### Test 2: Test Jadwal Manual
1. Lihat log `CURRENT TIME ANALYSIS` untuk waktu saat ini
2. Set `waktu_1` di Firebase = waktu saat ini + 2 menit
   - Contoh: Sekarang 10:30 → set `waktu_1: "10:32"`
3. Tunggu 2 menit
4. Harus muncul log `JADWAL 1 TRIGGERED: 10:32`

### Test 3: Verifikasi Queue
1. Saat jadwal trigger, cek log `Queue status:`
2. Pastikan ada `1 active` atau `1 waiting`
3. Kemudian lihat `Processing Job:` muncul

### Test 4: Verifikasi Firebase Aktuator
1. Saat job running, buka Firebase Console
2. Lihat node `/aktuator`
3. Pastikan mosvet yang relevan = `true`
4. Setelah durasi selesai, harus kembali `false`

---

## 🚨 Troubleshooting

### Problem: Log CHECK tidak muncul
**Diagnosis:** Worker crash atau interval tidak jalan
**Solution:** 
- Check Railway logs untuk error
- Restart worker di Railway Dashboard

### Problem: CHECK muncul tapi tidak TRIGGERED
**Diagnosis:** Format waktu tidak match
**Solution:**
- Cek log detail (setiap 3 check): lihat "Current: HH:MM"
- Bandingkan dengan "Jadwal 1: HH:MM" di Firebase
- Pastikan format sama persis (2 digit: "09:00" bukan "9:00")

### Problem: TRIGGERED tapi tidak Processing
**Diagnosis:** Queue error atau Redis disconnect
**Solution:**
- Cek log `HEALTH CHECK` untuk Redis status
- Cek log `Successfully added to queue`
- Restart Redis service jika perlu

### Problem: Processing tapi aktuator tidak ON
**Diagnosis:** Firebase update gagal atau node tidak ada
**Solution:**
- Cek log `Firebase update successful`
- Cek log `Verified aktuator state`
- Lihat Firebase Console untuk konfirmasi nilai

---

## 📝 Checklist Debugging

- [ ] Worker menghasilkan log `CHECK #X` setiap menit
- [ ] Counter naik terus (tidak reset tanpa alasan)
- [ ] Mode Waktu menunjukkan ✅ ENABLED di Firebase
- [ ] Format waktu di log match dengan jadwal (HH:MM)
- [ ] Saat match, muncul "🔔 MATCH!"
- [ ] Muncul "JADWAL X TRIGGERED"
- [ ] Muncul "Successfully added to queue"
- [ ] Queue status menunjukkan job active/waiting
- [ ] Muncul "Processing Job:"
- [ ] Muncul "Firebase update successful"
- [ ] Muncul "Verified aktuator state"
- [ ] Node `/aktuator` di Firebase berubah nilai
- [ ] Setelah durasi, aktuator OFF dan muncul log history

---

## 🎯 Expected Behavior

**Normal Flow:**
1. Worker start → Diagnostic checks (5 detik)
2. First check immediately → CHECK #1
3. Check setiap 60 detik → CHECK #2, #3, #4...
4. Saat match → TRIGGERED
5. Add to queue → Queue status updated
6. Worker process job → Aktuator ON
7. Wait duration → Progress logs setiap 10s
8. Duration done → Aktuator OFF
9. Log history → Complete

**Timeline Example:**
```
10:20:05 - Worker start + diagnostics
10:20:10 - First check (CHECK #1)
10:21:10 - CHECK #2
10:22:10 - CHECK #3 (detail log)
10:23:10 - CHECK #4
10:24:10 - CHECK #5
10:25:10 - CHECK #6 (detail log) + JADWAL TRIGGERED!
10:25:15 - Job processing started
10:25:15 - Aktuator ON
10:30:15 - Aktuator OFF (after 300s)
10:30:15 - History logged
10:30:15 - Job completed
```

---

## 💡 Tips

1. **Monitor Railway logs secara real-time** saat testing
2. **Gunakan waktu + 2 menit** untuk test (beri waktu buffer)
3. **Cek Firebase Console** bersamaan dengan Railway logs
4. **Screenshot error logs** jika ada masalah untuk analisis
5. **Restart worker** setelah update kode atau environment variable

---

## 📞 Support

Jika masih ada masalah setelah ikuti guide ini:
1. Export Railway logs (10 menit terakhir)
2. Screenshot Firebase `/kontrol` node
3. Screenshot Firebase `/aktuator` node
4. Catat waktu test dilakukan
5. Dokumentasikan expected vs actual behavior
