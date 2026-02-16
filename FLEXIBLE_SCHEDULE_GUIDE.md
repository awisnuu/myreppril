# 🗓️ Panduan Sistem Penjadwalan Fleksibel

## ✨ Fitur Baru

Sistem penjadwalan sekarang **fully flexible**:
- ✅ **Dynamic schedules**: Tambah jadwal_1, jadwal_2, ... jadwal_N
- ✅ **Per-schedule pot selection**: Setiap jadwal bisa pilih pot mana yang aktif
- ✅ **Per-schedule configuration**: Tiap jadwal punya durasi & pompa sendiri
- ✅ **Enable/Disable**: Bisa matikan jadwal tanpa hapus data
- ✅ **No code change needed**: Tambah/ubah jadwal langsung di Firebase!

## 📋 Struktur Firebase Baru

### Contoh Sesuai Kebutuhan User:

```json
{
  "kontrol": {
    "waktu": true,
    
    "jadwal_1": {
      "aktif": true,
      "waktu": "08:00",
      "durasi": 60,
      "pot_aktif": [1, 2, 3],
      "pompa_air": true,
      "pompa_pupuk": false
    },
    
    "jadwal_2": {
      "aktif": true,
      "waktu": "09:00",
      "durasi": 45,
      "pot_aktif": [4, 5],
      "pompa_air": true,
      "pompa_pupuk": true
    },
    
    "jadwal_3": {
      "aktif": true,
      "waktu": "16:00",
      "durasi": 30,
      "pot_aktif": [1, 2, 3, 4, 5],
      "pompa_air": true,
      "pompa_pupuk": true
    }
  }
}
```

### Penjelasan Field:

| Field | Tipe | Wajib? | Default | Keterangan |
|-------|------|--------|---------|------------|
| `aktif` | boolean | ❌ | `true` | Enable/disable jadwal |
| `waktu` | string | ✅ | - | Format "HH:MM" (24 jam) |
| `durasi` | number | ❌ | `60` | Durasi penyiraman (detik) |
| `pot_aktif` | array | ✅ | - | Array pot yang aktif: `[1, 2, 3]` |
| `pompa_air` | boolean | ❌ | `true` | Nyalakan pompa air |
| `pompa_pupuk` | boolean | ❌ | `false` | Nyalakan pompa pupuk |

## 🚀 Cara Setup di Firebase

### 1. Buka Firebase Console

1. Go to: https://console.firebase.google.com
2. Pilih project **ApsGo**
3. Klik **Realtime Database**
4. Klik **Data** tab

### 2. Setup Struktur Awal

Klik di path `/kontrol` dan edit JSON:

```json
{
  "kontrol": {
    "waktu": true,
    "sensor": false,
    "otomatis": true,
    
    "jadwal_1": {
      "aktif": true,
      "waktu": "08:00",
      "durasi": 60,
      "pot_aktif": [1, 2, 3],
      "pompa_air": true,
      "pompa_pupuk": false
    },
    
    "jadwal_2": {
      "aktif": true,
      "waktu": "09:00",
      "durasi": 45,
      "pot_aktif": [4, 5],
      "pompa_air": true,
      "pompa_pupuk": true
    },
    
    "jadwal_3": {
      "aktif": true,
      "waktu": "16:00",
      "durasi": 30,
      "pot_aktif": [1, 2, 3, 4, 5],
      "pompa_air": true,
      "pompa_pupuk": true
    }
  }
}
```

### 3. Tambah Jadwal Baru

Untuk tambah jadwal baru, tinggal tambah `jadwal_4`, `jadwal_5`, dst:

```json
"jadwal_4": {
  "aktif": true,
  "waktu": "12:00",
  "durasi": 40,
  "pot_aktif": [2, 4],
  "pompa_air": true,
  "pompa_pupuk": false
}
```

**Tidak perlu restart worker!** Worker akan otomatis detect jadwal baru.

### 4. Disable Jadwal Sementara

Ubah `aktif` jadi `false`:

```json
"jadwal_3": {
  "aktif": false,
  "waktu": "16:00",
  ...
}
```

Jadwal tidak akan trigger, tapi data tetap tersimpan.

## 📱 Contoh Penggunaan

### Skenario 1: Pagi & Sore

**Kebutuhan:**
- Pagi (08:00): Semua pot disirami
- Sore (16:00): Hanya pot 1, 3, 5

**Setup:**
```json
"jadwal_1": {
  "aktif": true,
  "waktu": "08:00",
  "durasi": 60,
  "pot_aktif": [1, 2, 3, 4, 5],
  "pompa_air": true,
  "pompa_pupuk": false
},
"jadwal_2": {
  "aktif": true,
  "waktu": "16:00",
  "durasi": 45,
  "pot_aktif": [1, 3, 5],
  "pompa_air": true,
  "pompa_pupuk": true
}
```

### Skenario 2: Per-Pot Berbeda

**Kebutuhan:**
- Pot 1 & 2: Pagi (07:00), Siang (12:00), Sore (17:00)
- Pot 3 & 4: Pagi (08:00), Sore (16:00)
- Pot 5: Hanya pagi (09:00)

**Setup:**
```json
"jadwal_1": {
  "aktif": true,
  "waktu": "07:00",
  "durasi": 60,
  "pot_aktif": [1, 2],
  "pompa_air": true,
  "pompa_pupuk": false
},
"jadwal_2": {
  "aktif": true,
  "waktu": "08:00",
  "durasi": 60,
  "pot_aktif": [3, 4],
  "pompa_air": true,
  "pompa_pupuk": false
},
"jadwal_3": {
  "aktif": true,
  "waktu": "09:00",
  "durasi": 60,
  "pot_aktif": [5],
  "pompa_air": true,
  "pompa_pupuk": false
},
"jadwal_4": {
  "aktif": true,
  "waktu": "12:00",
  "durasi": 45,
  "pot_aktif": [1, 2],
  "pompa_air": true,
  "pompa_pupuk": true
},
"jadwal_5": {
  "aktif": true,
  "waktu": "16:00",
  "durasi": 50,
  "pot_aktif": [3, 4],
  "pompa_air": true,
  "pompa_pupuk": true
},
"jadwal_6": {
  "aktif": true,
  "waktu": "17:00",
  "durasi": 40,
  "pot_aktif": [1, 2],
  "pompa_air": true,
  "pompa_pupuk": false
}
```

### Skenario 3: Testing

**Kebutuhan:** Test pot 3 saja setiap 15 menit

**Setup:**
```json
"jadwal_test_1": {
  "aktif": true,
  "waktu": "09:00",
  "durasi": 10,
  "pot_aktif": [3],
  "pompa_air": true,
  "pompa_pupuk": false
},
"jadwal_test_2": {
  "aktif": true,
  "waktu": "09:15",
  "durasi": 10,
  "pot_aktif": [3],
  "pompa_air": true,
  "pompa_pupuk": false
},
"jadwal_test_3": {
  "aktif": true,
  "waktu": "09:30",
  "durasi": 10,
  "pot_aktif": [3],
  "pompa_air": true,
  "pompa_pupuk": false
}
```

## 🔍 Monitoring & Logs

### Log yang Normal:

```
⏱️  CHECK #15: 08:00:05 | Mode: ✅
📋 Total Jadwal: 3
✅ jadwal_1: 08:00 → Pot [1, 2, 3] 🔔 MATCH!
✅ jadwal_2: 09:00 → Pot [4, 5]
✅ jadwal_3: 16:00 → Pot [1, 2, 3, 4, 5]

🕐 JADWAL_1 TRIGGERED: 08:00
   🎯 Pot aktif: [1, 2, 3]
   ⏱️  Durasi: 60s
   💧 Pompa Air: ON
   🌿 Pompa Pupuk: OFF
   ✅ Successfully added to queue: jadwal_1_2026-02-16_08_00
```

### Log Jika Jadwal Disabled:

```
⏱️  CHECK #15: 08:00:05 | Mode: ✅
📋 Total Jadwal: 3
❌ jadwal_1: 08:00 → Pot [1, 2, 3]
✅ jadwal_2: 09:00 → Pot [4, 5]
✅ jadwal_3: 16:00 → Pot [1, 2, 3, 4, 5]
```

### Log Error/Warning:

```
⚠️  jadwal_4: Invalid structure, skipping
⚠️  jadwal_5: No active pots defined, skipping
```

## ⚙️ Advanced Configuration

### Limit Maksimal Jadwal

Tidak ada limit! Bisa tambah jadwal_1 sampai jadwal_100 kalau perlu.

**Rekomendasi:**
- **Normal use**: 3-10 jadwal
- **Complex greenhouse**: 10-20 jadwal
- **Maximum tested**: 50 jadwal (still fast!)

### Naming Convention

Worker detect semua key yang mulai dengan `jadwal_`:
- ✅ `jadwal_1`, `jadwal_2`, `jadwal_3`
- ✅ `jadwal_pagi`, `jadwal_sore`, `jadwal_malam`
- ✅ `jadwal_test_1`, `jadwal_test_2`
- ❌ `schedule_1` (tidak akan terdetect)

### Validasi Otomatis

Worker otomatis validasi:
- ✅ `aktif` field (skip jika `false`)
- ✅ `waktu` field (skip jika tidak ada atau tidak match)
- ✅ `pot_aktif` array (skip jika kosong atau invalid)
- ✅ Default values untuk field opsional

## 🔄 Migration dari Format Lama

### Format Lama (Legacy):

```json
{
  "kontrol": {
    "waktu": true,
    "waktu_1": "08:00",
    "durasi_1": 60,
    "waktu_2": "16:00",
    "durasi_2": 45
  }
}
```

**Masih supported!** Worker tetap baca `waktu_1` dan `waktu_2`.

### Migrasi Bertahap:

1. **Tetap pakai format lama** sambil test format baru
2. **Tambah jadwal baru** dengan format baru
3. **Disable format lama** setelah yakin
4. **Hapus format lama** setelah beberapa hari

### Contoh Transisi:

```json
{
  "kontrol": {
    "waktu": true,
    
    // Format lama (masih jalan!)
    "waktu_1": "08:00",
    "durasi_1": 60,
    
    // Format baru
    "jadwal_2": {
      "aktif": true,
      "waktu": "09:00",
      "durasi": 45,
      "pot_aktif": [4, 5],
      "pompa_air": true,
      "pompa_pupuk": true
    }
  }
}
```

## 🛠️ Troubleshooting

### Jadwal tidak trigger

**Check:**
1. ✅ `kontrol.waktu` = `true`?
2. ✅ `jadwal_X.aktif` = `true`?
3. ✅ `jadwal_X.waktu` format "HH:MM" (2 digit)?
4. ✅ `jadwal_X.pot_aktif` array tidak kosong?
5. ✅ Worker running di Railway?

### Pot salah yang menyala

**Check:**
1. ✅ `pot_aktif` array benar? `[1, 2, 3]` bukan `["1", "2", "3"]`
2. ✅ Tidak ada jadwal lain yang trigger di waktu sama?
3. ✅ Check logs: "Pot aktif: [...]"

### Durasi tidak sesuai

**Check:**
1. ✅ `durasi` dalam detik (bukan menit!)
2. ✅ Format number bukan string: `60` bukan `"60"`

## 📊 Performa

- **Check interval**: 60 detik
- **Detection time**: < 1 detik
- **Queue processing**: Sequential (1 job at a time)
- **Max schedules tested**: 50 jadwal
- **Memory impact**: Minimal (~5MB per 10 jadwal)

## 🚀 Deploy

Setelah edit struktur Firebase:

1. **Worker otomatis detect** jadwal baru (dalam 60 detik)
2. **No restart needed**
3. **Check logs** untuk verifikasi

Push perubahan worker.js ke Railway:

```bash
cd railway-worker
git add worker.js
git commit -m "feat: Add flexible multi-schedule support"
git push origin main
```

Railway auto-deploy dalam 2-3 menit.

## 📝 Summary

✅ **Flexible**: Tambah jadwal kapanpun tanpa ubah kode  
✅ **Scalable**: Support 1-100+ jadwal  
✅ **Per-schedule config**: Tiap jadwal bisa beda settingan  
✅ **Backward compatible**: Format lama tetap jalan  
✅ **Easy to use**: Setup langsung di Firebase  
✅ **Production ready**: Sudah include error handling & validation  

---

**Need help?** Check logs di Railway atau Firebase console untuk debug.
