import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Import order: este módulo puede cargarse antes que `src/index.js`.
// Para evitar que `process.env` venga vacío, cargamos `.env` aquí también.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "ai-engine: faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno."
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);