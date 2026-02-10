# ApsGo Railway Worker

Background worker service untuk sistem otomasi IoT ApsGo. Service ini berjalan 24/7 di cloud untuk menjalankan penjadwalan dan automation bahkan ketika aplikasi mobile ditutup atau handphone pengguna mati.

## Features

- ✅ **Waktu Mode**: Penjadwalan berdasarkan waktu (cron-based)
- ✅ **Sensor Mode**: Otomasi berdasarkan threshold kelembapan tanah
- ✅ **Auto History Logging**: Record data sensor setiap 10 menit
- ✅ **Redis Queue**: Prevent race conditions dan manage concurrent tasks
- ✅ **Graceful Shutdown**: Clean shutdown dengan safety turn-off semua aktuator
- ✅ **Health Monitoring**: Auto health check setiap 5 menit
- ✅ **Auto Cleanup**: Hapus history lama otomatis (retain 30 hari)

## Tech Stack

- **Node.js**: Runtime environment
- **Firebase Admin SDK**: Realtime Database integration
- **BullMQ**: Robust job queue dengan Redis
- **Redis**: In-memory database untuk queue dan caching
- **Cron**: Scheduled tasks

## Setup Local Development

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` ke `.env` dan isi dengan credentials Firebase Anda:
```bash
cp .env.example .env
```

3. Setup Redis lokal (gunakan Docker):
```bash
docker run -d -p 6379:6379 redis:latest
```

4. Run worker:
```bash
npm run dev  # Development mode dengan nodemon
# atau
npm start    # Production mode
```

## Deploy to Railway

Lihat file `DEPLOYMENT_GUIDE.md` untuk step-by-step deployment ke Railway.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `FIREBASE_PROJECT_ID` | Firebase project ID | ✅ |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email | ✅ |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key | ✅ |
| `FIREBASE_DATABASE_URL` | Firebase Realtime Database URL | ✅ |
| `REDIS_HOST` | Redis hostname | ✅ |
| `REDIS_PORT` | Redis port (default: 6379) | ❌ |
| `REDIS_PASSWORD` | Redis password (if required) | ❌ |

## Architecture

```
Flutter App (Mobile)
        ↕
Firebase Realtime DB ← ESP32/Hardware
        ↕
Railway Worker (This service)
        ↕
   Redis Queue
```

## How It Works

### Waktu Mode
- Worker check Firebase `/kontrol` setiap 30 detik
- Jika `waktu_1` atau `waktu_2` match dengan waktu sekarang, add job ke queue
- Job akan diprocess oleh worker untuk nyalakan pompa dan valve
- Setelah durasi selesai, otomatis matikan

### Sensor Mode
- Worker listen ke Firebase `/data` secara realtime
- Jika `soil_X` < `batas_bawah`, trigger watering untuk pot tersebut
- Ada cooldown 2 menit per pot untuk prevent over-watering
- Support 2 mode: `fixed` (durasi tetap) dan `smart` (sampai mencapai batas_atas)

### Safety Features
- Concurrency: 1 (hanya 1 job diprocess pada satu waktu)
- Debouncing: Minimum 2 menit antar penyiraman per pot
- Error handling: Jika error, otomatis turn OFF semua aktuator
- Graceful shutdown: Clean up resources saat restart/shutdown

## Monitoring

Worker akan log semua aktivitas ke console:
- ✅ Success operations
- ❌ Errors dengan details
- 💧 Watering jobs progress
- 📊 History logging
- 💚 Health check status

Di Railway dashboard, Anda bisa:
- View logs realtime
- Monitor CPU/Memory usage
- Setup alerts untuk failures

## Maintenance

### Manual Queue Management

Untuk clear queue (jika ada masalah):
```javascript
const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);
const queue = new Queue('watering', { connection: redis });

// Clear all jobs
await queue.obliterate();
```

### Database Cleanup

History otomatis di-cleanup setiap hari jam 2 pagi, hanya retain 30 hari terakhir.

## Troubleshooting

### Worker tidak berjalan
1. Check environment variables
2. Check Firebase credentials
3. Check Redis connection

### Job tidak diprocess
1. Check queue status di logs
2. Verify Firebase rules mengizinkan admin access
3. Check concurrency setting

### Memory leak
- Worker menggunakan BullMQ yang sudah optimize untuk long-running process
- Auto cleanup completed jobs (retain last 100)
- Auto cleanup failed jobs (retain last 50)

## License

MIT
