import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function getPublishableKey(): string | null {
  const direct =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (direct) return direct;

  const keysJson = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (!keysJson) return null;
  try {
    const keys = JSON.parse(keysJson);
    if (keys && typeof keys.default === "string") return keys.default;
    const first = Object.values(keys).find((value) => typeof value === "string");
    return typeof first === "string" ? first : null;
  } catch {
    return null;
  }
}

const allowedCategories = new Set([
  "alimentos",
  "hortifruti",
  "carnes",
  "bebidas",
  "limpeza",
  "higiene",
  "outros",
]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return jsonResponse({ error: "Entre na sua conta para importar a tabela." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = getPublishableKey();
  if (!supabaseUrl || !publishableKey) {
    return jsonResponse({ error: "A configuração de autenticação do Supabase está incompleta." }, 500);
  }

  // Confirm the access token against Supabase Auth. Do not trust metadata supplied by the client.
  let authResponse: Response;
  try {
    authResponse = await fetch(supabaseUrl + "/auth/v1/user", {
      headers: { apikey: publishableKey, Authorization: authorization },
    });
  } catch {
    return jsonResponse({ error: "Não foi possível validar a conta no Supabase." }, 502);
  }
  if (!authResponse.ok) {
    return jsonResponse({ error: "Sua sessão expirou. Entre novamente e tente de novo." }, 401);
  }
  const authUser = await authResponse.json().catch(() => null);
  if (!authUser || typeof authUser.id !== "string") {
    return jsonResponse({ error: "Não consegui confirmar a conta autenticada." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Envie uma imagem válida." }, 400);
  }

  const marketId = typeof body.market_id === "string" ? body.market_id.trim() : "";
  const imageDataUrl = typeof body.image_data_url === "string" ? body.image_data_url : "";
  if (!marketId || marketId.length > 200) {
    return jsonResponse({ error: "O mercado selecionado é inválido." }, 400);
  }

  // Check membership using the user's own JWT and RLS; no service-role key is used here.
  const membershipUrl = new URL(supabaseUrl + "/rest/v1/market_admins");
  membershipUrl.searchParams.set("user_id", "eq." + authUser.id);
  membershipUrl.searchParams.set("market_id", "eq." + marketId);
  membershipUrl.searchParams.set("select", "market_id");
  membershipUrl.searchParams.set("limit", "1");
  let membershipResponse: Response;
  try {
    membershipResponse = await fetch(membershipUrl, {
      headers: { apikey: publishableKey, Authorization: authorization },
    });
  } catch {
    return jsonResponse({ error: "Não foi possível verificar o vínculo do mercado." }, 502);
  }
  if (!membershipResponse.ok) {
    return jsonResponse({ error: "Não foi possível verificar as permissões dessa conta." }, 403);
  }
  const memberships = await membershipResponse.json().catch(() => []);
  if (!Array.isArray(memberships) || memberships.length === 0) {
    return jsonResponse({ error: "Somente administradores aprovados deste mercado podem ler uma tabela." }, 403);
  }

  const openAiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiKey) {
    return jsonResponse({
      error: "Falta configurar OPENAI_API_KEY nos segredos das Edge Functions do Supabase. A chave fica no servidor, nunca no HTML.",
      setup_required: true,
    }, 503);
  }

  const match = imageDataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return jsonResponse({ error: "Use uma imagem JPG, PNG ou WebP válida." }, 400);
  }
  if (match[2].length > 8_600_000) {
    return jsonResponse({ error: "A imagem é muito grande. O limite é 6 MB." }, 413);
  }

  const prompt = [
    "Você é um assistente de entrada de preços para supermercados no Brasil.",
    "Leia a imagem da tabela de preços e retorne somente os produtos cujas linhas e preços possam ser lidos com razoável segurança.",
    "Os preços usam reais brasileiros. Converta vírgula decimal para número JSON: '5,99' vira 5.99. Nunca invente dígitos nem complete preços ilegíveis.",
    "Não retorne títulos, datas, códigos de barras, subtotais, totais, números de telefone nem textos promocionais que não sejam produtos.",
    "Para cada produto, extraia nome, marca quando fizer parte do nome, tamanho/unidade, preço atual, preço anterior apenas se a tabela mostrar claramente um preço anterior/lista, categoria, validade se estiver escrita claramente e confiança.",
    "Se houver preço promocional e preço normal claramente identificados, use o preço promocional como price e o preço normal como old_price. Caso contrário, old_price deve ser null.",
    "A validade deve ser YYYY-MM-DD somente quando a data completa puder ser determinada sem adivinhação. Caso contrário, null.",
    "Categorias permitidas: alimentos, hortifruti, carnes, bebidas, limpeza, higiene, outros.",
    "Se o item ou o preço estiver ilegível, omita essa linha. Não use preço por quilo como preço do pacote, nem o contrário.",
    "Limite a resposta a no máximo 100 produtos. Se houver vários preços na mesma linha, use somente os correspondentes ao mesmo produto.",
    "Retorne o nome do mercado apenas se estiver claramente impresso no cabeçalho da tabela.",
  ].join(" ");

  let aiResponse: Response;
  try {
    aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + openAiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        max_completion_tokens: 6000,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "price_table",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                market_name: { type: ["string", "null"] },
                products: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      size: { type: "string" },
                      price: { type: "number" },
                      old_price: { type: ["number", "null"] },
                      category: {
                        type: "string",
                        enum: ["alimentos", "hortifruti", "carnes", "bebidas", "limpeza", "higiene", "outros"],
                      },
                      valid_until: { type: ["string", "null"] },
                      confidence: { type: "string", enum: ["alta", "media", "baixa"] },
                    },
                    required: ["name", "size", "price", "old_price", "category", "valid_until", "confidence"],
                  },
                },
              },
              required: ["market_name", "products"],
            },
          },
        },
        messages: [
          {
            role: "system",
            content: "Extraia dados visíveis sem adivinhar. Siga exatamente o esquema JSON solicitado.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
            ],
          },
        ],
      }),
    });
  } catch {
    return jsonResponse({ error: "Não foi possível conectar ao serviço de leitura por IA." }, 502);
  }

  const aiBody = await aiResponse.json().catch(() => null);
  if (!aiResponse.ok) {
    const upstreamMessage =
      typeof aiBody?.error?.message === "string" ? aiBody.error.message : "Erro no serviço de IA.";
    console.error("OpenAI price-table request failed with status", aiResponse.status);
    return jsonResponse({
      error: aiResponse.status === 401
        ? "A chave da OpenAI está inválida. Confira o segredo OPENAI_API_KEY no Supabase."
        : aiResponse.status === 429
        ? "A API da OpenAI está sem saldo disponível ou no limite de uso. Confira sua conta de API."
        : "A IA não conseguiu processar a imagem. " + upstreamMessage,
    }, aiResponse.status === 429 ? 429 : 502);
  }

  const content = aiBody?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return jsonResponse({ error: "A IA não retornou uma leitura utilizável. Tente uma foto mais nítida." }, 502);
  }

  let parsed: { market_name?: unknown; products?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    return jsonResponse({ error: "A IA retornou um formato inesperado. Tente novamente." }, 502);
  }

  const rawProducts = Array.isArray(parsed.products) ? parsed.products : [];
  const products = rawProducts.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 140) : "";
    const size = typeof row.size === "string" ? row.size.trim().slice(0, 60) : "";
    const price = typeof row.price === "number" ? row.price : Number.NaN;
    if (name.length < 2 || !Number.isFinite(price) || price < 0) return [];
    const old = typeof row.old_price === "number" && Number.isFinite(row.old_price) && row.old_price > price
      ? row.old_price
      : null;
    const category = typeof row.category === "string" && allowedCategories.has(row.category)
      ? row.category
      : "alimentos";
    const validUntil = typeof row.valid_until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.valid_until)
      ? row.valid_until
      : null;
    const confidence = row.confidence === "alta" || row.confidence === "baixa"
      ? row.confidence
      : "media";
    return [{ name, size, price: Math.round(price * 100) / 100, old_price: old, category, valid_until: validUntil, confidence }];
  });

  return jsonResponse({
    market_name: typeof parsed.market_name === "string" ? parsed.market_name.slice(0, 160) : null,
    products,
    total: products.length,
  });
});
