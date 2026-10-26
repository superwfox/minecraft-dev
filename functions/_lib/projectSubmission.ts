export interface Submission { id: string; kind: string; hash: string; state: any; leaseToken?: string }
export async function submission(db: D1Database, id: string, uid: string, kind: string, hash: string): Promise<Submission> {
    await db.prepare("INSERT OR IGNORE INTO project_submissions (submission_id,owner_uid,kind,payload_hash,state_json,updated_at) VALUES (?,?,?,?,?,?)").bind(id, uid, kind, hash, "{}", Date.now()).run();
    const row: any = await db.prepare("SELECT * FROM project_submissions WHERE submission_id=? AND owner_uid=?").bind(id, uid).first();
    if (!row || row.kind !== kind || row.payload_hash !== hash) throw new Error("submissionId 已用于其他内容，请保留原内容重试或重新提交");
    return { id, kind, hash, state: JSON.parse(row.state_json) };
}
export async function saveSubmission(db: D1Database, item: Submission, uid: string) {
    const result = item.leaseToken
        ? await db.prepare("UPDATE project_submissions SET state_json=?,updated_at=?,lease_until=? WHERE submission_id=? AND owner_uid=? AND payload_hash=? AND lease_token=?").bind(JSON.stringify(item.state), Date.now(), Date.now() + 120000, item.id, uid, item.hash, item.leaseToken).run()
        : await db.prepare("UPDATE project_submissions SET state_json=?,updated_at=? WHERE submission_id=? AND owner_uid=? AND payload_hash=?").bind(JSON.stringify(item.state), Date.now(), item.id, uid, item.hash).run();
    if (!result.meta.changes) throw new Error("提交状态已被其他请求更新，请查询后重试");
}
export async function lockSubmission(db: D1Database, id: string, uid: string) {
    const token = crypto.randomUUID();
    const result = await db.prepare("UPDATE project_submissions SET lease_until=?,lease_token=? WHERE submission_id=? AND owner_uid=? AND lease_until<?").bind(Date.now() + 120000, token, id, uid, Date.now()).run();
    return result.meta.changes ? token : "";
}
export async function unlockSubmission(db: D1Database, id: string, uid: string, token: string) {
    await db.prepare("UPDATE project_submissions SET lease_until=0,lease_token='' WHERE submission_id=? AND owner_uid=? AND lease_token=?").bind(id, uid, token).run();
}
