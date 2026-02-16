/**
 * Script untuk setup Firebase Jadwal
 * Run: node setup-firebase-jadwal.js
 */

require('dotenv').config();
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  process.exit(1);
}

const db = admin.database();

// Data jadwal yang akan di-setup
const kontrolData = {
  waktu: true,
  sensor: false,
  otomatis: true,
  
  batas_atas: 32,
  batas_bawah: 11,
  durasi_sensor: 600,
  mode_sensor: "smart",
  
  jadwal_1: {
    aktif: true,
    waktu: "08:00",
    durasi: 60,
    pot_aktif: [1, 2, 3],
    pompa_air: true,
    pompa_pupuk: false
  },
  
  jadwal_2: {
    aktif: true,
    waktu: "09:00",
    durasi: 45,
    pot_aktif: [4, 5],
    pompa_air: true,
    pompa_pupuk: true
  },
  
  jadwal_3: {
    aktif: true,
    waktu: "16:00",
    durasi: 30,
    pot_aktif: [1, 2, 3, 4, 5],
    pompa_air: true,
    pompa_pupuk: true
  },
  
  jadwal_4: {
    aktif: false,
    waktu: "12:00",
    durasi: 40,
    pot_aktif: [2, 4],
    pompa_air: true,
    pompa_pupuk: false
  },
  
  jadwal_5: {
    aktif: false,
    waktu: "18:00",
    durasi: 50,
    pot_aktif: [1, 5],
    pompa_air: true,
    pompa_pupuk: false
  }
};

async function setupFirebase() {
  try {
    console.log('\n🚀 Starting Firebase setup...');
    console.log('📍 Path: /kontrol_1');
    console.log('📋 Data:', JSON.stringify(kontrolData, null, 2));
    
    // Set data ke Firebase di path /kontrol_1
    await db.ref('kontrol_1').set(kontrolData);
    
    console.log('\n✅ Firebase setup completed successfully!');
    console.log('📊 Summary:');
    console.log(`   - Path: /kontrol_1`);
    console.log(`   - Mode Waktu: ${kontrolData.waktu ? 'ENABLED' : 'DISABLED'}`);
    console.log(`   - Total Jadwal: 5`);
    console.log(`   - Jadwal Aktif: ${Object.keys(kontrolData).filter(k => k.startsWith('jadwal_') && kontrolData[k].aktif).length}`);
    
    console.log('\n📝 Jadwal yang di-setup:');
    Object.keys(kontrolData).forEach(key => {
      if (key.startsWith('jadwal_')) {
        const jadwal = kontrolData[key];
        console.log(`   ${jadwal.aktif ? '✅' : '❌'} ${key}: ${jadwal.waktu} → Pot [${jadwal.pot_aktif.join(', ')}] (${jadwal.durasi}s)`);
      }
    });
    
    console.log('\n🎉 Done! Data sudah tersimpan di Firebase.');
    console.log('📱 Sekarang update Flutter app untuk pakai path /kontrol_1');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error setting up Firebase:', error);
    process.exit(1);
  }
}

// Run setup
setupFirebase();
