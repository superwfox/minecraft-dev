const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
export const onRequestGet: PagesFunction<{ DB?: D1Database }> = async context => {
    if (!context.env.DB) return json({ events: [], cursor: 0, incomplete: true, reason: "journal_storage_unavailable" });
    const url = new URL(context.request.url), taskId = url.searchParams.get("taskId") || "", cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    try {
        const rows = await context.env.DB.prepare("SELECT sequence,event_id,recorded_at,kind,payload FROM project_journal WHERE owner_uid=? AND task_id=? AND sequence>? AND expires_at>? ORDER BY sequence LIMIT 50").bind(String(context.data.uid || ""), taskId, cursor, Date.now()).all();
        const events = rows.results.map((row: any) => ({ sequence: row.sequence, id: row.event_id, at: row.recorded_at, kind: row.kind, ...JSON.parse(row.payload) }));
        const health: any = await context.env.DB.prepare("SELECT expected_events,completed_events,failed_events,MAX(pruned_through,COALESCE((SELECT MAX(sequence) FROM project_journal j WHERE j.task_id=project_journal_health.task_id AND j.owner_uid=project_journal_health.owner_uid AND j.expires_at<=?),0)) AS expired_through FROM project_journal_health WHERE task_id=? AND owner_uid=?").bind(Date.now(), taskId, String(context.data.uid || "")).first();
        const retentionGap = health && health.expired_through > cursor;
        return json({ events, cursor: events.at(-1)?.sequence || cursor, more: events.length === 50, incomplete: !health || health.failed_events > 0 || !!retentionGap, ...(retentionGap ? { reason: "journal_retention_gap" } : {}), pending: health && health.expected_events !== health.completed_events });
    } catch { return json({ events: [], cursor, incomplete: true, reason: "journal_migration_required" }); }
};
