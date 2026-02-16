/**
 * Script untuk setup Firebase Threshold System
 * Run: node setup-firebase-threshold.js
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

// Data threshold yang akan di-setup
// Akan merge dengan data yang sudah ada (jadwal_1, jadwal_2, dll)
const thresholdData = {
  threshold_1: {
    aktif: true,
    batas_bawah: 30,      // Kelembaban minimum 30%
    batas_atas: 70,       // Target kelembaban 70% (untuk smart mode)
    durasi: 600,          // 10 menit (untuk fixed mode)
    smart_mode: true,     // Smart mode: siram sampai mencapai batas_atas
    pot_aktif: [1, 2, 3], // Pot 1, 2, 3 pakai threshold ini
    pompa_air: true,
    pompa_pupuk: false
  },
  
  threshold_2: {
    aktif: true,
    batas_bawah: 40,      // Kelembaban minimum 40%
    batas_atas: 80,       // Target kelembaban 80%
    durasi: 300,          // 5 menit
    smart_mode: false,    // Fixed mode: siram selama durasi saja
    pot_aktif: [4, 5],    // Pot 4, 5 pakai threshold ini
    pompa_air: true,
    pompa_pupuk: true
  },
  
  threshold_3: {
    aktif: false,
    batas_bawah: 25,      // Untuk tanaman yang butuh kelembaban lebih tinggi
    batas_atas: 75,
    durasi: 480,          // 8 menit
    smart_mode: true,
    pot_aktif: [3],       // Hanya pot 3
    pompa_air: true,
    pompa_pupuk: false
  }
};

async function setupThreshold() {
  try {
    console.log('\n📦 Starting Threshold System setup...');
    console.log('📍 Target path: /kontrol_1\n');

    // Get existing data di kontrol_1
    const existingSnapshot = await db.ref('kontrol_1').get();
    const existingData = existingSnapshot.val() || {};

    console.log('📋 Existing data keys:', Object.keys(existingData).join(', '));

    // Merge threshold baru dengan data yang sudah ada
    const mergedData = {
      ...existingData,
      ...thresholdData
    };

    // Push ke Firebase
    await db.ref('kontrol_1').set(mergedData);
    
    console.log('\n✅ Threshold system setup completed!');
    console.log('\n📊 Summary:');
    console.log(`   Total keys in kontrol_1: ${Object.keys(mergedData).length}`);
    console.log(`   Jadwal nodes: ${Object.keys(mergedData).filter(k => k.startsWith('jadwal_')).length}`);
    console.log(`   Threshold nodes: ${Object.keys(mergedData).filter(k => k.startsWith('threshold_')).length}`);
    
    console.log('\n🎯 Threshold details:');
    Object.keys(thresholdData).forEach(key => {
      const t = thresholdData[key];
      console.log(`   ${key}: ${t.aktif ? '✅' : '❌'} | ${t.batas_bawah}-${t.batas_atas}% | ${t.smart_mode ? 'Smart' : 'Fixed'} | Pot ${t.pot_aktif.join(',')}`);
    });

    console.log('\n✨ Firebase updated successfully!');
    console.log('🔗 Check: https://console.firebase.google.com/u/0/project/YOUR_PROJECT/database');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Run the setup
setupThreshold();
