/**
 * Helper script untuk extract Firebase credentials dari Service Account JSON
 * dan generate .env file yang benar
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('🔥 Firebase Credentials Extractor\n');
console.log('This tool will help you create a valid .env file from Firebase Service Account JSON.\n');

rl.question('Enter path to your Firebase Service Account JSON file: ', (jsonPath) => {
  try {
    // Read and parse JSON
    if (!fs.existsSync(jsonPath)) {
      console.error('❌ File not found:', jsonPath);
      console.error('\nTip: Drag and drop the JSON file to this terminal to get its path.');
      process.exit(1);
    }
    
    console.log('\n📖 Reading JSON file...');
    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
    const credentials = JSON.parse(jsonContent);
    
    // Validate required fields
    const required = ['project_id', 'private_key', 'client_email'];
    const missing = required.filter(field => !credentials[field]);
    
    if (missing.length > 0) {
      console.error('❌ Missing required fields in JSON:', missing.join(', '));
      process.exit(1);
    }
    
    console.log('✅ JSON file parsed successfully');
    console.log(`   Project ID: ${credentials.project_id}`);
    console.log(`   Client Email: ${credentials.client_email}`);
    
    // Extract database URL
    const databaseURL = credentials.databaseURL || 
                       `https://${credentials.project_id}-default-rtdb.firebaseio.com`;
    
    // Generate .env content
    const envContent = `# Firebase Configuration
# Generated from Service Account JSON on ${new Date().toISOString()}

FIREBASE_PROJECT_ID=${credentials.project_id}
FIREBASE_CLIENT_EMAIL=${credentials.client_email}
FIREBASE_PRIVATE_KEY="${credentials.private_key}"
FIREBASE_DATABASE_URL=${databaseURL}

# Redis Configuration (Railway will auto-provide these)
# REDIS_HOST=localhost
# REDIS_PORT=6379
# REDIS_PASSWORD=
`;
    
    // Write to .env
    const envPath = path.join(__dirname, '.env');
    fs.writeFileSync(envPath, envContent);
    
    console.log('\n✅ .env file created successfully!');
    console.log(`   Location: ${envPath}`);
    
    console.log('\n📋 Next steps:');
    console.log('   1. Test the connection:');
    console.log('      node test-firebase-direct.js');
    console.log('   2. If successful, deploy to Railway');
    console.log('   3. Add same variables to Railway Dashboard');
    
    rl.close();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    
    if (error instanceof SyntaxError) {
      console.error('\n💡 The file is not valid JSON. Make sure you downloaded the');
      console.error('   Service Account Key from Firebase Console correctly.');
    }
    
    rl.close();
    process.exit(1);
  }
});

rl.on('close', () => {
  process.exit(0);
});