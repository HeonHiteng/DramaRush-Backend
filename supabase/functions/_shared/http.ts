/**
 * Small helpers shared by every Keybox Edge Function: CORS, JSON responses,
 * env access, caller identity.
 */
import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.45.4";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Stable, machine-readable error codes for the app; never includes internals. */
export function errorResponse(code: string, status: number): Response {
  return json({ error: code }, status);
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method_not_allowed", 405);
  return null;
}

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  return Deno.env.get(name) || undefined;
}

export function listEnv(name: string): string[] {
  return (optionalEnv(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Service-role client: bypasses RLS. Only use after the caller has been checked. */
export function serviceClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Fresh anon-key client with no caller, e.g. to sign a user in with a password. */
export function anonClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client that acts as the caller (RLS applies), for checks like is_admin(). */
export function callerClient(req: Request): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

/** The signed-in caller (guests included), verified against Supabase Auth. */
export async function getCaller(req: Request, admin: SupabaseClient): Promise<User | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

export async function isAdmin(req: Request): Promise<boolean> {
  const { data, error } = await callerClient(req).rpc("is_admin");
  return !error && data === true;
}

export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Episode ids are slugs like `crimson-contract-ep4`. */
export function episodeIdFrom(body: Record<string, unknown> | null): string | null {
  const id = body?.episode_id;
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(id) ? id : null;
}

/** Best-effort client IP, for the playback log only (never for access decisions). */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = req.headers.get("cf-connecting-ip") ?? forwarded ?? null;
  return ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
}
