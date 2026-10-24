export const onRequest: PagesFunction = () => new Response(JSON.stringify({ error: "该接口已随结构树重构下线", code: "FEATURE_DEPRECATED" }), { status: 410, headers: { "Content-Type": "application/json" } });
