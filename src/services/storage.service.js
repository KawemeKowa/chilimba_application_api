const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'files';

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('File storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)');
    }
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { realtime: { transport: ws } }
    );
  }
  return _client;
}

async function uploadFile(storagePath, buffer, mimetype) {
  const supabase = getClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: mimetype, upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data.publicUrl;
}

async function deleteFile(storagePath) {
  const supabase = getClient();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

module.exports = { uploadFile, deleteFile };
