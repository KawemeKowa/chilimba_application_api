-- Add cover photo URL to groups table
ALTER TABLE groups ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
