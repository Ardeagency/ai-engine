-- migrate_v8_chat_attachments.sql
-- Soporte multimedia en el chat de Vera:
--   1. Columna attachments en ai_messages (metadatos de archivos adjuntos)
--   2. Bucket de Supabase Storage: chat-attachments
--   3. RLS policies del bucket

-- ── 1. Columna attachments ────────────────────────────────────────────────────
ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT NULL;

COMMENT ON COLUMN ai_messages.attachments IS
  'Array de archivos adjuntos al mensaje. Estructura por elemento:
   { url: string, type: "image"|"pdf"|"audio"|"video"|"file",
     name: string, mime: string }';

-- ── 2. Bucket chat-attachments ────────────────────────────────────────────────
-- El bucket es PÚBLICO en lectura para que ai-engine pueda descargar los archivos.
-- Las escrituras requieren autenticación (controladas por RLS abajo).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-attachments',
  'chat-attachments',
  true,
  26214400,   -- 25 MB máximo por archivo
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/ogg',
    'audio/webm', 'audio/aac', 'audio/x-m4a',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit   = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 3. RLS del bucket ─────────────────────────────────────────────────────────
-- Subida: solo usuarios autenticados (miembros de alguna org)
CREATE POLICY "chat_attachments_upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments');

-- Lectura pública (el bucket ya es public=true, pero agregamos política explícita)
CREATE POLICY "chat_attachments_read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'chat-attachments');

-- Borrado: solo el dueño del objeto
CREATE POLICY "chat_attachments_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND owner = auth.uid()
  );
