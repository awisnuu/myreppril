/**
 * Script untuk TEST koneksi Firebase dan verify data penjadwalan
 * Usage: node test-firebase-connection.js
 * 
 * Script ini akan:
 * 1. Connect ke Firebase
 * 2. Baca data /kontrol/
 * 3. Display struktur data dan format
 * 4. Verify apakah data penjadwalan ada
 */

require('dotenv').config();
const admin = require('firebase-admin');

console.log('🔍 Testing Firebase Connection & Data Structure...\n');

// Initialize Firebase
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
  console.log('✅ Firebase initialized\n');
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  process.exit(1);
}

const db = admin.database();

async function testConnection() {
  try {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 READING /kontrol/ FROM FIREBASE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const snapshot = await db.ref('kontrol').once('value');
    const kontrolData = snapshot.val();

    if (!kontrolData) {
      console.log('❌ NO DATA FOUND at /kontrol/\n');
      console.log('💡 Kemungkinan masalah:');
      console.log('   1. Data belum di-set dari Flutter app');
      console.log('   2. Firebase credentials salah');
      console.log('   3. Database URL salah\n');
      return;
    }

    console.log('✅ DATA FOUND! Structure:\n');
    console.log(JSON.stringify(kontrolData, null, 2));
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 VALIDATING WAKTU MODE DATA');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Validate Waktu Mode
    const checks = {
      'waktu (mode enabled)': kontrolData.waktu,
      'waktu_1 (jadwal 1)': kontrolData.waktu_1,
      'waktu_2 (jadwal 2)': kontrolData.waktu_2,
      'durasi_1 (detik)': kontrolData.durasi_1,
      'durasi_2 (detik)': kontrolData.durasi_2,
    };

    let allValid = true;
    for (const [key, value] of Object.entries(checks)) {
      const exists = value !== undefined && value !== null;
      const icon = exists ? '✅' : '❌';
      console.log(`${icon} ${key.padEnd(25)} = ${value ?? 'NOT SET'}`);
      if (!exists) allValid = false;
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏰ CURRENT TIME vs SCHEDULE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    
    console.log(`🕐 Current time: ${currentTime}`);
    console.log(`📅 Jadwal 1:     ${kontrolData.waktu_1 || 'NOT SET'}`);
    console.log(`📅 Jadwal 2:     ${kontrolData.waktu_2 || 'NOT SET'}`);
    
    if (kontrolData.waktu_1 === currentTime) {
      console.log('\n🔥 JADWAL 1 SHOULD TRIGGER NOW!');
    } else if (kontrolData.waktu_2 === currentTime) {
      console.log('\n🔥 JADWAL 2 SHOULD TRIGGER NOW!');
    } else {
      console.log('\n⏳ No schedule at current time');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎯 DIAGNOSIS RESULT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (allValid && kontrolData.waktu === true) {
      console.log('✅ DATA STRUCTURE VALID');
      console.log('✅ WAKTU MODE ENABLED');
      console.log('\n💡 If Railway logs still empty, check:');
      console.log('   1. Railway root directory = "railway-worker"');
      console.log('   2. Environment variables di Railway');
      console.log('   3. Railway deployment status (Logs tab)');
      console.log('   4. Redis service is running\n');
    } else {
      console.log('❌ DATA STRUCTURE INCOMPLETE or MODE DISABLED\n');
      
      if (!kontrolData.waktu) {
        console.log('⚠️  waktu = false → Mode waktu TIDAK AKTIF');
        console.log('    💡 Aktifkan dari Flutter app!\n');
      }
      
      if (!kontrolData.waktu_1 || !kontrolData.waktu_2) {
        console.log('⚠️  Jadwal belum di-set');
        console.log('    💡 Set jadwal dari Flutter app!\n');
      }
    }

    // Check Sensor Mode
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🌡️  SENSOR MODE DATA');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const sensorChecks = {
      'otomatis (mode enabled)': kontrolData.otomatis,
      'batas_bawah': kontrolData.batas_bawah,
      'batas_atas': kontrolData.batas_atas,
      'durasi_sensor': kontrolData.durasi_sensor,
    };

    for (const [key, value] of Object.entries(sensorChecks)) {
      const exists = value !== undefined && value !== null;
      const icon = exists ? '✅' : '❌';
      console.log(`${icon} ${key.padEnd(25)} = ${value ?? 'NOT SET'}`);
    }

    console.log('\n✅ Test complete!\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

testConnection();
