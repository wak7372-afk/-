const appOrigin = Deno.env.get('APP_ORIGIN') ?? '';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': appOrigin || 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() });
  return new Response(JSON.stringify({
    error: 'استعادة كلمة المرور الذاتية موقفة حالياً. راجع إدارة المركز.',
    code: 'RECOVERY_DISABLED',
  }), {
    status: 410,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
});
