# ⚙️ SETUP RAILWAY WORKER - FIREBASE CREDENTIALS

## 🔑 Cara Mendapatkan Firebase Credentials

### **Step 1: Download Service Account Key**

1. Buka **[Firebase Console](https://console.firebase.google.com)**
2. Pilih project: **project-ta-951b4**
3. Klik ⚙️ icon (Settings) → **Project Settings**
4. Tab **Service Accounts**
5. Klik button **"Generate New Private Key"**
6. Klik **"Generate Key"** → File JSON akan terdownload

---

### **Step 2: Extract Values dari JSON**

Buka file JSON yang didownload (misalnya: `project-ta-951b4-xxxxx.json`) dengan text editor.

**Copy values berikut:**

```json
{
  "type": "service_account",
  "project_id": "project-ta-951b4",                           ← COPY INI
  "client_email": "firebase-adminsdk-xxxxx@project-ta-951b4.iam.gserviceaccount.com",  ← COPY INI
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADA...\n-----END PRIVATE KEY-----\n",  ← COPY INI
  ...
}
```

---

### **Step 3: Update File .env**

Edit file: `railway-worker/.env`

```env
FIREBASE_PROJECT_ID=project-ta-951b4
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@project-ta-951b4.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADA...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://project-ta-951b4-default-rtdb.firebaseio.com
```

**⚠️ PENTING untuk PRIVATE_KEY:**
- Harus dalam quotes `"`
- Harus ada `\n` (backslash-n), bukan newline sebenarnya
- Copy langsung dari JSON file (sudah format benar)

---

### **Step 4: Test Lokal (Optional)**

```powershell
cd railway-worker
node test-firebase-connection.js
```

**Expected output:**
```
✅ Firebase initialized
✅ DATA FOUND! Structure:
✅ DATA STRUCTURE VALID
```

---

### **Step 5: Set di Railway**

**Railway Dashboard → Service myreppril → Variables tab:**

Add 4 variables (tanpa quotes!):

| Variable | Value |
|----------|-------|
| `FIREBASE_PROJECT_ID` | `project-ta-951b4` |
| `FIREBASE_CLIENT_EMAIL` | `firebase-adminsdk-xxxxx@project-ta-951b4.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADA...\n-----END PRIVATE KEY-----\n` |
| `FIREBASE_DATABASE_URL` | `https://project-ta-951b4-default-rtdb.firebaseio.com` |

**Railway akan auto-redeploy setelah add variables!**

---

## 🚀 Setelah Setup

### **Check Railway Logs:**

Railway → Service myreppril → Tab **Logs**

**Harus muncul:**
```
🚀 Starting ApsGo Railway Worker...
📡 Firebase Project: project-ta-951b4
✅ Firebase Admin initialized
✅ Redis connected
✅ Waktu Mode scheduler started
```

---

## ⚠️ Troubleshooting

### **Error: "Firebase initialization failed"**
- Check PRIVATE_KEY format (harus dengan `\n`)
- Pastikan tidak ada extra spaces atau quotes di Railway Variables
- Regenerate key jika perlu

### **Error: "Redis connection failed"**
- Add Redis database di Railway (+ New → Database → Redis)
- Tunggu auto-inject variables

### **No logs at all in Railway**
- Set Root Directory = `railway-worker`
- Check Deployments tab untuk build errors

---

## 📞 Next Steps

Setelah .env file ready:
1. Test lokal: `node test-firebase-connection.js`
2. Set variables di Railway
3. Wait for auto-redeploy
4. Check Railway logs

**Jika masih stuck, screenshot:**
- Railway Variables tab
- Railway Deployments status
- Error message (if any)
