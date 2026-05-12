-- Remove the age restriction constraint from users
ALTER TABLE users DROP CONSTRAINT IF EXISTS age_check;
