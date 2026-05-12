import { supabase } from "./supabase.js";

/**
 * Extrae el JWT del header Authorization (Supabase access_token del cliente).
 */
export function getBearerToken(req) {
  const raw = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/**
 * Valida el access_token contra Auth de Supabase (misma lógica que Netlify Functions).
 */
export async function fetchUserFromAccessToken(accessToken) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw Object.assign(new Error("Falta SUPABASE_ANON_KEY en ai-engine"), {
      statusCode: 500,
    });
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * El usuario debe ser dueño de la org o miembro en organization_members.
 */
export async function assertOrgMember(organizationId, userId) {
  const { data: owners, error: ownerErr } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .eq("owner_user_id", userId)
    .limit(1);

  if (ownerErr) {
    const e = new Error(ownerErr.message);
    e.statusCode = 500;
    throw e;
  }
  if (owners?.length) return;

  const { data: members, error: memErr } = await supabase
    .from("organization_members")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .limit(1);

  if (memErr) {
    const e = new Error(memErr.message);
    e.statusCode = 500;
    throw e;
  }
  if (members?.length) return;

  const err = new Error("No autorizado para esta organización");
  err.statusCode = 403;
  throw err;
}

/**
 * Comprueba que la conversación exista y pertenezca a la organización.
 */
export async function assertConversationInOrg(conversationId, organizationId) {
  const { data, error } = await supabase
    .from("ai_conversations")
    .select("id, organization_id")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    const e = new Error(error.message);
    e.statusCode = 500;
    throw e;
  }
  if (!data?.id) {
    const err = new Error("Conversation not found for organization");
    err.statusCode = 404;
    throw err;
  }
}
